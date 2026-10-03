FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY matcher ./matcher
RUN pip install --no-cache-dir .
ENV PORT=8080
CMD ["sh", "-c", "uvicorn matcher.app:app --host 0.0.0.0 --port ${PORT}"]
