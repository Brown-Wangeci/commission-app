"""FastAPI inference service.

Run with:
    uvicorn src.serve.app:app --host 127.0.0.1 --port 8000
(host and port default to config/serving.yaml if run via `python -m src.serve.app`)

Endpoints:
    POST /score                     score one activation, persist the record
    GET  /health                    model version and load status
    GET  /explain/{activation_id}   the stored record for a scored activation
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, HTTPException

from . import schemas, settings
from .service import ScoringService

_state: Dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        _state["service"] = ScoringService()
    except Exception as exc:  # model failed to load; /health reports it, /score fails clearly
        _state["error"] = str(exc)
    yield
    service = _state.get("service")
    if service is not None:
        service.db.close()


app = FastAPI(title="Activation Fraud Scoring Service", lifespan=lifespan)


def _service() -> ScoringService:
    service = _state.get("service")
    if service is None:
        raise HTTPException(status_code=503, detail=_state.get("error", "model not loaded"))
    return service


@app.get("/health", response_model=schemas.HealthResponse)
def health() -> schemas.HealthResponse:
    service = _state.get("service")
    if service is None:
        return schemas.HealthResponse(status="unavailable", model_version=None, loaded=False)
    return schemas.HealthResponse(status="ok", model_version=service.artifact.version, loaded=True)


@app.post("/score", response_model=schemas.ScoreResponse)
def score(request: schemas.ScoreRequest) -> schemas.ScoreResponse:
    service = _service()
    try:
        scored = service.score(
            activation=request.activation.model_dump(mode="python"),
            agents=[a.model_dump(mode="python") for a in request.agents],
            recent_activations=[a.model_dump(mode="python") for a in request.recent_activations],
            payout_calendar=[c.model_dump(mode="python") for c in request.payout_calendar],
            downstream_activity=[d.model_dump(mode="python") for d in request.downstream_activity],
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return schemas.ScoreResponse(
        activation_id=scored.activation_id,
        model_version=scored.model_version,
        raw_score=scored.raw_score,
        calibrated_probability=scored.calibrated_probability,
        band=scored.band,
        release_threshold=scored.release_threshold,
        reject_threshold=scored.reject_threshold,
        top_reasons=[
            schemas.ReasonContribution(
                feature=r.feature, is_agent_level=r.is_agent_level,
                direction=r.direction, shap_value=r.shap_value, description=r.description,
            )
            for r in scored.top_reasons
        ],
        scored_at=scored.scored_at,
    )


@app.get("/explain/{activation_id}", response_model=schemas.ExplainResponse)
def explain(activation_id: str) -> schemas.ExplainResponse:
    service = _service()
    record = service.db.latest_for_activation(activation_id)
    if record is None:
        raise HTTPException(
            status_code=404, detail=f"no stored prediction for activation_id {activation_id!r}"
        )
    return schemas.ExplainResponse(
        activation_id=record["activation_id"],
        scored_at=record["scored_at"],
        model_version=record["model_version"],
        config_hash=record["config_hash"],
        feature_vector=record["feature_vector"],
        raw_score=record["raw_score"],
        calibrated_probability=record["calibrated_probability"],
        band=record["band"],
        release_threshold=record["release_threshold"],
        reject_threshold=record["reject_threshold"],
        top_reasons=[schemas.ReasonContribution(**r) for r in record["top_reasons"]],
    )


def main() -> None:
    import uvicorn

    cfg = settings.load_serving_config()
    uvicorn.run("src.serve.app:app", host=str(cfg["host"]), port=int(cfg["port"]))


if __name__ == "__main__":
    main()
