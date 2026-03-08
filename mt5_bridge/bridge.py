"""
FayeTradeX – MT5 Bridge
========================
FastAPI HTTP service that wraps MetaTrader5 Python library.
Run on the Windows machine where MT5 terminal is installed.

Start:
    pip install -r requirements.txt
    python bridge.py

Env vars (.env in this directory):
    MT5_LOGIN      – broker account number
    MT5_PASSWORD   – account password
    MT5_SERVER     – broker server name (e.g. ICMarkets-Demo)
    MT5_PATH       – optional: full path to terminal64.exe
    BRIDGE_HOST    – host to listen on (default 0.0.0.0)
    BRIDGE_PORT    – port (default 8765)
    BRIDGE_SECRET  – shared secret header expected from backend (optional)
"""

from __future__ import annotations
import os, sys, time, uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("[WARN] MetaTrader5 package not found – running in MOCK mode")

from fastapi import FastAPI, HTTPException, Request, Depends
from pydantic import BaseModel
from typing import Optional

# ── Config ───────────────────────────────────────────────────────────────────
MT5_LOGIN    = int(os.getenv("MT5_LOGIN", "0"))
MT5_PASSWORD = os.getenv("MT5_PASSWORD", "")
MT5_SERVER   = os.getenv("MT5_SERVER", "")
MT5_PATH     = os.getenv("MT5_PATH", None)
BRIDGE_SECRET = os.getenv("BRIDGE_SECRET", "")

# ── MT5 connection ────────────────────────────────────────────────────────────
def mt5_connect() -> bool:
    if not MT5_AVAILABLE:
        return False
    kwargs = dict(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    if not mt5.initialize(**kwargs):
        print(f"[ERROR] MT5 init failed: {mt5.last_error()}")
        return False
    info = mt5.account_info()
    print(f"[INFO] MT5 connected: {info.login} @ {info.server}")
    return True

@asynccontextmanager
async def lifespan(app: FastAPI):
    mt5_connect()
    yield
    if MT5_AVAILABLE:
        mt5.shutdown()

app = FastAPI(title="FayeTradeX MT5 Bridge", lifespan=lifespan)

# ── Auth guard ────────────────────────────────────────────────────────────────
def check_secret(req: Request):
    if BRIDGE_SECRET and req.headers.get("X-Bridge-Secret") != BRIDGE_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")

# ── Models ────────────────────────────────────────────────────────────────────
class PlaceOrderRequest(BaseModel):
    symbol: str
    order_type: str           # "BUY" | "SELL"
    lot: float
    price: Optional[float] = None
    sl: Optional[float] = None
    tp: Optional[float] = None
    magic: int = 20240001
    comment: str = "FayeTradeX"
    idempotency_key: str = ""

class ModifyPositionRequest(BaseModel):
    ticket: int
    sl: Optional[float] = None
    tp: Optional[float] = None

class PartialCloseRequest(BaseModel):
    ticket: int
    lot: float

class ClosePositionRequest(BaseModel):
    ticket: int

# ── Helpers ───────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _ensure_connected():
    if not MT5_AVAILABLE:
        return  # mock mode – let it pass
    if not mt5.terminal_info():
        if not mt5_connect():
            raise HTTPException(status_code=503, detail="MT5 not connected")

def _pos_to_dict(p) -> dict:
    return {
        "ticket": p.ticket,
        "symbol": p.symbol,
        "side":   "BUY" if p.type == 0 else "SELL",
        "lot":    p.volume,
        "open_price": p.price_open,
        "sl":     p.sl,
        "tp":     p.tp,
        "profit": p.profit,
        "swap":   p.swap,
        "open_time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
        "comment": p.comment,
        "magic":  p.magic,
    }

# ── Mock fallback ─────────────────────────────────────────────────────────────
_mock_positions: dict[int, dict] = {}
_mock_ticket_counter = 100000

def _mock_place(req: PlaceOrderRequest) -> dict:
    global _mock_ticket_counter
    _mock_ticket_counter += 1
    t = _mock_ticket_counter
    price = req.price or (1.1234 if req.order_type == "BUY" else 1.1230)
    _mock_positions[t] = {
        "ticket": t, "symbol": req.symbol,
        "side": req.order_type, "lot": req.lot,
        "open_price": price, "sl": req.sl, "tp": req.tp,
        "profit": 0.0, "swap": 0.0,
        "open_time": _now_iso(), "comment": req.comment, "magic": req.magic,
    }
    return {"ticket": t, "price": price, "mock": True}

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health(_=Depends(check_secret)):
    if not MT5_AVAILABLE:
        return {"status": "mock", "mt5": False}
    connected = bool(mt5.terminal_info())
    if not connected:
        connected = mt5_connect()
    acct = mt5.account_info() if connected else None
    return {
        "status": "connected" if connected else "disconnected",
        "mt5": connected,
        "login": acct.login if acct else None,
        "server": acct.server if acct else None,
    }

@app.get("/account_info")
def account_info(_=Depends(check_secret)):
    if not MT5_AVAILABLE:
        return {"balance": 10000, "equity": 10000, "margin": 0,
                "free_margin": 10000, "currency": "USD", "mock": True}
    _ensure_connected()
    a = mt5.account_info()
    if not a:
        raise HTTPException(status_code=502, detail=str(mt5.last_error()))
    return {
        "login": a.login, "name": a.name, "server": a.server,
        "balance": a.balance, "equity": a.equity,
        "margin": a.margin, "free_margin": a.margin_free,
        "currency": a.currency, "leverage": a.leverage,
    }

@app.get("/quote/{symbol}")
def get_quote(symbol: str, _=Depends(check_secret)):
    if not MT5_AVAILABLE:
        return {"symbol": symbol, "bid": 1.1230, "ask": 1.1232,
                "point": 0.00001, "digits": 5, "mock": True}
    _ensure_connected()
    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)
    if not tick or not info:
        raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")
    return {
        "symbol": symbol,
        "bid": tick.bid, "ask": tick.ask,
        "spread": round(tick.ask - tick.bid, info.digits),
        "point": info.point, "digits": info.digits,
        "time": datetime.fromtimestamp(tick.time, tz=timezone.utc).isoformat(),
    }

@app.get("/ohlc/{symbol}")
def get_ohlc(symbol: str, timeframe: str = "H1", bars: int = 200, _=Depends(check_secret)):
    tf_map = {
        "M1": mt5.TIMEFRAME_M1 if MT5_AVAILABLE else 1,
        "M5": mt5.TIMEFRAME_M5 if MT5_AVAILABLE else 5,
        "M15": mt5.TIMEFRAME_M15 if MT5_AVAILABLE else 15,
        "H1": mt5.TIMEFRAME_H1 if MT5_AVAILABLE else 60,
        "H4": mt5.TIMEFRAME_H4 if MT5_AVAILABLE else 240,
        "D1": mt5.TIMEFRAME_D1 if MT5_AVAILABLE else 1440,
    }
    if not MT5_AVAILABLE:
        # Return minimal mock OHLC
        now = int(time.time())
        mock_bars = []
        for i in range(min(bars, 50)):
            t = now - i * 3600
            mock_bars.append({"time": t, "open": 1.12, "high": 1.125,
                               "low": 1.115, "close": 1.122, "tick_volume": 100})
        return {"symbol": symbol, "timeframe": timeframe, "bars": mock_bars, "mock": True}

    _ensure_connected()
    tf = tf_map.get(timeframe.upper(), mt5.TIMEFRAME_H1)
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, bars)
    if rates is None:
        raise HTTPException(status_code=502, detail=f"No data for {symbol}/{timeframe}")
    result = []
    for r in rates:
        result.append({
            "time": int(r["time"]),
            "open": float(r["open"]), "high": float(r["high"]),
            "low": float(r["low"]), "close": float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
        })
    return {"symbol": symbol, "timeframe": timeframe, "bars": result}

@app.post("/place_order")
def place_order(req: PlaceOrderRequest, _=Depends(check_secret)):
    if not MT5_AVAILABLE:
        return _mock_place(req)

    _ensure_connected()
    info = mt5.symbol_info(req.symbol)
    if not info:
        raise HTTPException(status_code=404, detail=f"Symbol {req.symbol} not found")

    tick = mt5.symbol_info_tick(req.symbol)
    price = req.price or (tick.ask if req.order_type == "BUY" else tick.bid)
    action = mt5.ORDER_TYPE_BUY if req.order_type == "BUY" else mt5.ORDER_TYPE_SELL

    request = {
        "action":   mt5.TRADE_ACTION_DEAL,
        "symbol":   req.symbol,
        "volume":   req.lot,
        "type":     action,
        "price":    price,
        "deviation": 20,
        "magic":    req.magic,
        "comment":  req.comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if req.sl: request["sl"] = req.sl
    if req.tp: request["tp"] = req.tp

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=502,
                            detail=f"MT5 error {result.retcode}: {result.comment}")
    return {"ticket": result.order, "price": result.price, "volume": result.volume}

@app.post("/modify_position")
def modify_position(req: ModifyPositionRequest, _=Depends(check_secret)):
    if not MT5_AVAILABLE:
        if req.ticket in _mock_positions:
            if req.sl is not None: _mock_positions[req.ticket]["sl"] = req.sl
            if req.tp is not None: _mock_positions[req.ticket]["tp"] = req.tp
        return {"ok": True, "mock": True}

    _ensure_connected()
    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        raise HTTPException(status_code=404, detail="Position not found")
    pos = positions[0]

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": req.ticket,
        "sl": req.sl if req.sl is not None else pos.sl,
        "tp": req.tp if req.tp is not None else pos.tp,
    }
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=502,
                            detail=f"MT5 error {result.retcode}: {result.comment}")
    return {"ok": True, "ticket": req.ticket}

@app.post("/partial_close")
def partial_close(req: PartialCloseRequest, _=Depends(check_secret)):
    if not MT5_AVAILABLE:
        if req.ticket in _mock_positions:
            _mock_positions[req.ticket]["lot"] = max(0, _mock_positions[req.ticket]["lot"] - req.lot)
        return {"ok": True, "mock": True}

    _ensure_connected()
    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        raise HTTPException(status_code=404, detail="Position not found")
    pos = positions[0]
    tick = mt5.symbol_info_tick(pos.symbol)
    price = tick.bid if pos.type == 0 else tick.ask  # close = opposite side
    close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY

    request = {
        "action":   mt5.TRADE_ACTION_DEAL,
        "symbol":   pos.symbol,
        "volume":   req.lot,
        "type":     close_type,
        "position": req.ticket,
        "price":    price,
        "deviation": 20,
        "comment":  "FayeTradeX partial",
    }
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=502,
                            detail=f"MT5 error {result.retcode}: {result.comment}")
    return {"ok": True, "ticket": req.ticket, "closed_lot": req.lot}

@app.post("/close_position")
def close_position(req: ClosePositionRequest, _=Depends(check_secret)):
    if not MT5_AVAILABLE:
        _mock_positions.pop(req.ticket, None)
        return {"ok": True, "mock": True}

    _ensure_connected()
    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        raise HTTPException(status_code=404, detail="Position not found")
    pos = positions[0]
    tick = mt5.symbol_info_tick(pos.symbol)
    price = tick.bid if pos.type == 0 else tick.ask
    close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY

    request = {
        "action":   mt5.TRADE_ACTION_DEAL,
        "symbol":   pos.symbol,
        "volume":   pos.volume,
        "type":     close_type,
        "position": req.ticket,
        "price":    price,
        "deviation": 20,
        "comment":  "FayeTradeX close",
    }
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=502,
                            detail=f"MT5 error {result.retcode}: {result.comment}")
    return {"ok": True, "ticket": req.ticket}

@app.get("/sync_positions")
def sync_positions(_=Depends(check_secret)):
    if not MT5_AVAILABLE:
        return {"positions": list(_mock_positions.values()), "mock": True}
    _ensure_connected()
    positions = mt5.positions_get()
    if positions is None:
        return {"positions": []}
    return {"positions": [_pos_to_dict(p) for p in positions]}

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    host = os.getenv("BRIDGE_HOST", "0.0.0.0")
    port = int(os.getenv("BRIDGE_PORT", "8765"))
    print(f"[INFO] Starting MT5 bridge on {host}:{port}")
    uvicorn.run("bridge:app", host=host, port=port, reload=False)
