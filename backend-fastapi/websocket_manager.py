"""
WebSocketManager — fan-out broadcaster.

Maintains a set of active WebSocket connections and broadcasts
JSON messages to all of them concurrently.
"""

import asyncio
from typing import Set
from fastapi import WebSocket


class WebSocketManager:
    def __init__(self):
        self._clients: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)
        print(f"[WS] Client connected. Total: {len(self._clients)}")

    def disconnect(self, websocket: WebSocket):
        self._clients.discard(websocket)
        print(f"[WS] Client disconnected. Total: {len(self._clients)}")

    async def broadcast(self, message: str):
        """Send message to all connected clients concurrently."""
        if not self._clients:
            return

        dead: Set[WebSocket] = set()
        # Fire all sends concurrently for minimal latency
        results = await asyncio.gather(
            *[self._send(ws, message) for ws in list(self._clients)],
            return_exceptions=True,
        )
        for ws, result in zip(list(self._clients), results):
            if isinstance(result, Exception):
                dead.add(ws)

        async with self._lock:
            self._clients -= dead

    @staticmethod
    async def _send(websocket: WebSocket, message: str):
        await websocket.send_text(message)

    @property
    def client_count(self) -> int:
        return len(self._clients)
