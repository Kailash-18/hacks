"""Stable JSON error shape: {"error": {"code": "...", "message": "..."}}."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}


def register_error_handlers(app) -> None:
    """Install handlers on a FastAPI app (imported lazily so core logic has no FastAPI dependency)."""
    from fastapi import Request
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):  # noqa: ANN202
        return JSONResponse(status_code=exc.status_code, content=exc.body())

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):  # noqa: ANN202
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []))
        msg = f"Invalid request: {first.get('msg', 'validation failed')}" + (f" ({where})" if where else "")
        return JSONResponse(status_code=422, content={"error": {"code": "invalid_request", "message": msg}})
