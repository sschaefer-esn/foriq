import asyncio
import json
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from utils.dependencies import get_current_user

router = APIRouter(prefix="/api/v1/events", tags=["events"])


class EventManager:
    def __init__(self):
        self.connections: dict[str, list[asyncio.Queue]] = {}
        # Event loop of the SSE stream. broadcast() is often called from worker
        # threads (asyncio.to_thread in ingest, background threads in
        # settings.py/ota.py). asyncio.Queue.put_nowait is NOT thread-safe:
        # called directly from a foreign thread it does not wake the get()
        # consumer waiting in the loop -> events get stuck (the UI only updates
        # on reload). Hence delivery is scheduled via call_soon_threadsafe.
        self._loop: asyncio.AbstractEventLoop | None = None

    def connect(self, company_id: str) -> asyncio.Queue:
        # connect() always runs in the async SSE handler -> capture the loop here.
        self._loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        self.connections.setdefault(company_id, []).append(queue)
        return queue

    def disconnect(self, company_id: str, queue: asyncio.Queue):
        queues = self.connections.get(company_id, [])
        if queue in queues:
            queues.remove(queue)
        if not queues:
            self.connections.pop(company_id, None)

    def broadcast(self, company_id: str, event_type: str, data: dict):
        queues = self.connections.get(company_id, [])
        if not queues or self._loop is None:
            return
        message = json.dumps(data, default=str)
        event = {"event": event_type, "data": message}
        for queue in queues:
            # Thread-safe: wakes the event loop even when broadcast comes from a
            # worker/background thread. Equally correct from the loop thread itself.
            self._loop.call_soon_threadsafe(queue.put_nowait, event)


event_manager = EventManager()


@router.get("/stream")
async def event_stream(user=Depends(get_current_user)):
    company_id = user["company_id"]
    queue = event_manager.connect(company_id)

    async def generate():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"event: {event['event']}\ndata: {event['data']}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            event_manager.disconnect(company_id, queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
