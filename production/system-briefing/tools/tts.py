"""Синтез реплик из edit/narration.json голосом Microsoft Neural (edge-tts, онлайн).

Запуск:  py production/system-briefing/tools/tts.py [L01 L02 ...]
В сервис уходит только текст реплик. Сервис иногда отвечает пустым потоком
(NoAudioReceived) — каждая реплика повторяется до успешного ответа.
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import edge_tts

BASE = Path(__file__).resolve().parents[1]
OUT = BASE / "audio" / "vo"


def _shift(value: str, delta: int, unit: str) -> str:
    number = int(value.replace(unit, "")) + delta
    return f"{number:+d}{unit}"


VARIANTS = [
    lambda r, p: (r, p),
    lambda r, p: (r, _shift(p, 1, "Hz")),
    lambda r, p: (r, _shift(p, -1, "Hz")),
    lambda r, p: (_shift(r, 1, "%"), p),
    lambda r, p: (_shift(r, -1, "%"), p),
    lambda r, p: (_shift(r, 1, "%"), _shift(p, 1, "Hz")),
]


async def synth(text: str, voice: str, rate: str, pitch: str) -> bytes:
    audio = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    return bytes(audio)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    cfg = json.loads((BASE / "edit" / "narration.json").read_text(encoding="utf-8"))
    only = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    for line in cfg["lines"]:
        if only and line["id"] not in only:
            continue
        for attempt in range(1, 41):
            # Пустой ответ повторяется для одного и того же сочетания текста и параметров, поэтому на повторах
            # высота и темп сдвигаются на 1 Гц / 1 % — на слух это не отличить.
            rate, pitch = VARIANTS[(attempt - 1) % len(VARIANTS)](cfg["rate"], cfg["pitch"])
            try:
                data = asyncio.run(synth(line["tts"], cfg["voice"], rate, pitch))
                if len(data) > 1000:
                    (OUT / f"{line['id']}.mp3").write_bytes(data)
                    print(f"{line['id']}: ok (попытка {attempt}, rate {rate}, pitch {pitch})", flush=True)
                    break
            except Exception as error:  # noqa: BLE001
                last = type(error).__name__
            time.sleep(min(0.5 * attempt, 4))
        else:
            print(f"{line['id']}: не удалось ({last})")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
