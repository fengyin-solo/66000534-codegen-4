import asyncio, math, random, time, json, threading, re
from bisect import bisect_left, bisect_right
from collections import defaultdict, deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import numpy as np

app = FastAPI(title="Digital Twin Factory Monitor")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DEVICE_TYPES = ["CNC", "RobotArm", "Conveyor", "AGV", "InjectionMolding", "QCStation"]
STATUSES = ["RUNNING", "IDLE", "FAULT", "OFFLINE"]
SHIFTS = ["早班", "中班", "晚班"]
ACTIVE_CLIENTS: list[WebSocket] = []
SIMULATOR_RUNNING = True
MAIN_LOOP = None

class DeviceState:
    def __init__(self, did: int, dtype: str, x: float, y: float, z: float):
        self.id = did
        self.type = dtype
        self.shift = SHIFTS[(did - 1) % len(SHIFTS)]
        self.status = "RUNNING"
        self.position = [x, y, z]
        self.temperature = random.uniform(35, 45)
        self.vibration = random.uniform(0.1, 1.5)
        self.pressure = random.uniform(0.8, 1.2)
        self.production_count = 0
        self.fault_count = 0
        self.uptime = 0.0
        self.cycle_time = random.uniform(2, 8)
        self.quality_rate = random.uniform(0.95, 0.995)

    def to_dict(self):
        return {
            "id": self.id, "type": self.type, "status": self.status, "shift": self.shift,
            "position": self.position, "temperature": round(self.temperature, 2),
            "vibration": round(self.vibration, 3), "pressure": round(self.pressure, 2),
            "production_count": self.production_count, "fault_count": self.fault_count,
            "uptime": round(self.uptime, 2), "quality_rate": round(self.quality_rate, 3)
        }

devices = {i: DeviceState(i, random.choice(DEVICE_TYPES),
                          random.uniform(-5, 5), 0.5, random.uniform(-5, 5)) for i in range(1, 13)}

# 每秒一次的累计量快照 (uptime, production_count)，用于按观察时段重算 OEE
class DeviceHistory:
    """按时间升序的累计量快照，支持 O(log n) 时段端点查询。"""
    __slots__ = ("ts", "up", "prod")

    def __init__(self):
        self.ts: list[float] = []
        self.up: list[float] = []
        self.prod: list[int] = []

    def append(self, ts: float, up: float, prod: int):
        self.ts.append(ts)
        self.up.append(up)
        self.prod.append(prod)
        if len(self.ts) > 90000:  # 约保留一天，批量裁剪
            del self.ts[:10000]
            del self.up[:10000]
            del self.prod[:10000]

    def window_edges(self, t0: float, t1: float):
        """返回窗口内首/末快照；窗口无数据返回 None。"""
        i = bisect_left(self.ts, t0)
        j = bisect_right(self.ts, t1) - 1
        if j < i or i >= len(self.ts):
            return None
        return (self.ts[i], self.up[i], self.prod[i]), (self.ts[j], self.up[j], self.prod[j])


device_history = {i: DeviceHistory() for i in devices}

production_log = []
anomaly_log = []

# ---------- OEE 判定口径 ----------
METRIC_KEYS = ["availability", "performance", "quality"]
METRIC_LABELS = {"availability": "可用性", "performance": "性能", "quality": "质量"}
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

DEFAULT_CRITERIA = {
    "availability": {"lower": 85.0, "upper": 100.0, "window_start": "00:00", "window_end": "23:59"},
    "performance":  {"lower": 90.0, "upper": 100.0, "window_start": "00:00", "window_end": "23:59"},
    "quality":      {"lower": 95.0, "upper": 100.0, "window_start": "00:00", "window_end": "23:59"},
}
criteria_lock = threading.Lock()
active_criteria = json.loads(json.dumps(DEFAULT_CRITERIA))


def validate_criteria(payload: dict) -> list[str]:
    """返回不合格项列表；为空表示校验通过。"""
    errors = []
    for key in METRIC_KEYS:
        label = METRIC_LABELS[key]
        m = payload.get(key)
        if not isinstance(m, dict):
            errors.append(f"{label}: 配置缺失")
            continue
        lower, upper = m.get("lower"), m.get("upper")
        ws, we = m.get("window_start"), m.get("window_end")
        if lower is None or upper is None:
            errors.append(f"{label}: 上下限不能为空")
        elif not (0 <= lower <= 100 and 0 <= upper <= 100):
            errors.append(f"{label}: 上下限须在 0~100 之间（当前 {lower}~{upper}）")
        elif lower > upper:
            errors.append(f"{label}: 下限 {lower} 大于上限 {upper}，上下限填反")
        if not ws or not we:
            errors.append(f"{label}: 观察时段不能为空")
        else:
            m0, m1 = HHMM.match(str(ws).strip()), HHMM.match(str(we).strip())
            if not m0 or not m1:
                errors.append(f"{label}: 观察时段格式须为 HH:MM（当前 {ws}~{we}）")
            else:
                t0 = int(m0.group(1)) * 60 + int(m0.group(2))
                t1 = int(m1.group(1)) * 60 + int(m1.group(2))
                if t0 >= t1:
                    errors.append(f"{label}: 观察时段起止填反（{ws} 须早于 {we}）")
    return errors


def current_criteria() -> dict:
    with criteria_lock:
        return json.loads(json.dumps(active_criteria))


class MetricCriteria(BaseModel):
    lower: float
    upper: float
    window_start: str
    window_end: str


class OEECriteriaIn(BaseModel):
    availability: MetricCriteria
    performance: MetricCriteria
    quality: MetricCriteria


def window_bounds(window_start: str, window_end: str, now: float):
    """HH:MM 观察时段 -> 当日时间戳区间，结束时刻不超过当前时间。"""
    lt = time.localtime(now)
    day0 = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    h0, m0 = window_start.split(":")
    h1, m1 = window_end.split(":")
    t0 = day0 + int(h0) * 3600 + int(m0) * 60
    t1 = day0 + int(h1) * 3600 + int(m1) * 60
    return t0, min(t1, now)


def device_window_metrics(dev: DeviceState, bounds: dict):
    """按三项各自的观察时段，从历史快照重算可用性/性能/质量（与累计口径同一定义）。"""
    hist = device_history[dev.id]
    out = {}
    for k in METRIC_KEYS:
        t0, t1 = bounds[k]
        edges = hist.window_edges(t0, t1)
        if edges is None or edges[1][0] - edges[0][0] < 1:
            out[k] = None
            continue
        (ts0, up0, prod0), (ts1, up1, prod1) = edges
        dt = ts1 - ts0
        up = up1 - up0
        prod = prod1 - prod0
        availability = min(1.0, up / dt) * 100
        performance = min(1.0, prod / max(1.0, up / 2)) * 100
        quality = dev.quality_rate * 100
        out[k] = {"availability": availability, "performance": performance, "quality": quality}[k]
    return out


def calculate_oee():
    now = time.time()
    crit = current_criteria()
    bounds = {k: window_bounds(crit[k]["window_start"], crit[k]["window_end"], now)
              for k in METRIC_KEYS}
    oee_list = []
    for dev in devices.values():
        vals = device_window_metrics(dev, bounds)
        rounded = {k: (round(vals[k], 1) if vals[k] is not None else None) for k in METRIC_KEYS}
        below = [k for k in METRIC_KEYS
                 if rounded[k] is not None and rounded[k] < crit[k]["lower"]]
        oee = None
        if all(rounded[k] is not None for k in METRIC_KEYS):
            oee = round(rounded["availability"] * rounded["performance"] * rounded["quality"] / 10000, 1)
        oee_list.append({"id": dev.id, "type": dev.type, "shift": dev.shift,
                         "oee": oee, "availability": rounded["availability"],
                         "performance": rounded["performance"], "quality": rounded["quality"],
                         "below": below})
    return oee_list, crit


class AnomalyRules:
    def __init__(self):
        self.rules = [
            {"name": "高温告警", "field": "temperature", "threshold": 48, "op": "gt"},
            {"name": "振动超标", "field": "vibration", "threshold": 2.0, "op": "gt"},
            {"name": "压力异常", "field": "pressure", "threshold": 1.5, "op": "gt"},
        ]
        self.windows = defaultdict(lambda: deque(maxlen=10))

    def check(self, dev: DeviceState):
        triggers = []
        for rule in self.rules:
            val = getattr(dev, rule["field"])
            if (rule["op"] == "gt" and val > rule["threshold"]) or (rule["op"] == "lt" and val < rule["threshold"]):
                triggers.append({"device_id": dev.id, "rule": rule["name"],
                                 "value": round(val, 3), "threshold": rule["threshold"]})

        # sliding window trend
        key = f"{dev.id}_temp"
        self.windows[key].append(dev.temperature)
        if len(self.windows[key]) >= 8:
            vals = list(self.windows[key])
            if np.mean(vals[-4:]) - np.mean(vals[:4]) > 3:
                triggers.append({"device_id": dev.id, "rule": "温度趋势上升", "value": round(np.mean(vals[-4:]), 2), "threshold": ">3°C/周期"})

        if triggers:
            anomaly_log.append({"timestamp": time.time(), "triggers": triggers, "device_type": dev.type})
        return triggers

rules_engine = AnomalyRules()

def simulate():
    while SIMULATOR_RUNNING:
        now = time.time()
        for dev in devices.values():
            drift = 0.1 * math.sin(now * 0.5 + dev.id)
            noise = random.gauss(0, 0.3)
            dev.temperature = max(25, min(65, dev.temperature + drift + noise))

            v_drift = 0.02 * math.sin(now * 0.3 + dev.id * 0.7)
            dev.vibration = max(0, min(3, dev.vibration + v_drift + random.gauss(0, 0.05)))

            dev.pressure = max(0.5, min(2, dev.pressure + random.gauss(0, 0.02)))

            if random.random() < 0.015:
                dev.status = "FAULT"
                dev.fault_count += 1
            elif random.random() < 0.03 and dev.status == "FAULT":
                dev.status = "RUNNING"

            if dev.status == "RUNNING":
                if random.random() < 0.4:
                    dev.production_count += 1
                dev.uptime += 1

            device_history[dev.id].append(now, dev.uptime, dev.production_count)

            triggers = rules_engine.check(dev)
            if triggers and dev.status != "FAULT" and random.random() < 0.3:
                dev.status = "FAULT"

        production_log.append({"timestamp": now, "count": sum(d.production_count for d in devices.values())})

        try:
            oee, crit = calculate_oee()
            payload = {
                "devices": [d.to_dict() for d in devices.values()],
                "production": sum(d.production_count for d in devices.values()),
                "anomalies": anomaly_log[-5:] if anomaly_log else [],
                "oee": oee,
                "criteria": crit
            }
            msg = json.dumps(payload)
        except Exception:
            continue

        dead = []
        for ws in ACTIVE_CLIENTS:
            try:
                asyncio.run_coroutine_threadsafe(ws.send_text(msg), MAIN_LOOP)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in ACTIVE_CLIENTS:
                ACTIVE_CLIENTS.remove(ws)

        time.sleep(1)


@app.on_event("startup")
async def startup():
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()
    t = threading.Thread(target=simulate, daemon=True)
    t.start()


@app.get("/api/devices")
def get_devices():
    return {"devices": [d.to_dict() for d in devices.values()], "anomalies": anomaly_log[-10:]}


@app.get("/api/oee")
def get_oee():
    oee, crit = calculate_oee()
    return {"oee": oee, "criteria": crit}


@app.get("/api/oee/criteria")
def get_criteria():
    return {"criteria": current_criteria()}


@app.put("/api/oee/criteria")
def put_criteria(body: OEECriteriaIn):
    global active_criteria
    payload = body.dict()
    errors = validate_criteria(payload)
    if errors:
        # 校验失败：不保存，返回不合格项与当前生效口径
        return JSONResponse(status_code=422,
                            content={"detail": {"errors": errors, "active": current_criteria()}})
    with criteria_lock:
        active_criteria = payload
    return {"criteria": current_criteria()}


@app.get("/api/production")
def get_production():
    return {"log": production_log[-60:]}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    ACTIVE_CLIENTS.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in ACTIVE_CLIENTS:
            ACTIVE_CLIENTS.remove(websocket)


@app.on_event("shutdown")
async def shutdown():
    global SIMULATOR_RUNNING
    SIMULATOR_RUNNING = False
