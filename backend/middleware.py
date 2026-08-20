"""on_reasoning middleware — inject optimized prompt into the request.

When a session has a pending optimization result, this middleware
replaces the last user message content with the optimized text.
"""
from __future__ import annotations

import logging
from typing import Any, AsyncGenerator, Awaitable, Callable, TYPE_CHECKING

from agentscope.middleware import MiddlewareBase

from .store import TemplateStore

if TYPE_CHECKING:
    from agentscope.agent import Agent

logger = logging.getLogger(__name__)


class PromptInjectMiddleware(MiddlewareBase):
    """Inject optimized prompt from session pending results."""

    def __init__(self, store: TemplateStore | None = None) -> None:
        self._store = store

    async def on_reasoning(
        self,
        agent: "Agent",
        input_kwargs: dict,
        next_handler: Callable[
            ...,
            Awaitable[AsyncGenerator[Any, None]],
        ],
    ) -> AsyncGenerator[Any, None]:
        # 1. Check for per-request override first
        rc = getattr(agent, "_request_context", None) or {}
        optimization = rc.get("prompt_optimization")

        # 2. Fall back to session pending result
        if optimization is None and self._store is not None:
            session_id = str(rc.get("session_id") or "")
            if session_id:
                pending = self._store.get_pending(session_id)
                if pending:
                    optimization = pending
                    # Clear pending after use
                    self._store.clear_pending(session_id)

        if not optimization:
            async for item in next_handler(**input_kwargs):
                yield item
            return

        # 3. Replace last user message with optimized text
        optimized_text = optimization.get("optimized_text", "")
        if not optimized_text:
            async for item in next_handler(**input_kwargs):
                yield item
            return

        messages = input_kwargs.get("messages", [])
        if not isinstance(messages, list):
            async for item in next_handler(**input_kwargs):
                yield item
            return

        # Find and replace the last user message
        modified = False
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            role = msg.get("role", "") if isinstance(msg, dict) else getattr(msg, "role", "")
            if role == "user":
                if isinstance(msg, dict):
                    messages[i] = {**msg, "content": optimized_text}
                else:
                    msg.content = optimized_text
                modified = True
                break

        if modified:
            input_kwargs = dict(input_kwargs)
            input_kwargs["messages"] = messages
            logger.info(
                "[prompt-optimizer-plus] injected optimized prompt session=%s",
                str(rc.get("session_id", ""))[:24],
            )

        async for item in next_handler(**input_kwargs):
            yield item
