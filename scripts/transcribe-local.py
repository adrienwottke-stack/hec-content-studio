import json
import sys
import wave
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)
model = Model(sys.argv[1])
with wave.open(sys.argv[2], 'rb') as audio:
    if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
        raise ValueError('Expected mono PCM16 audio at 16 kHz')
    recognizer = KaldiRecognizer(model, 16000)
    recognizer.SetWords(True)
    parts = []
    while True:
        chunk = audio.readframes(4000)
        if not chunk:
            break
        if recognizer.AcceptWaveform(chunk):
            parts.append(json.loads(recognizer.Result()))
    parts.append(json.loads(recognizer.FinalResult()))
segments = []
for part in parts:
    words = part.get('result', [])
    if words and part.get('text'):
        segments.append({'from': round(words[0]['start'], 3), 'to': round(words[-1]['end'], 3),
                         'text': part['text'], 'confidence': round(sum(w['conf'] for w in words) / len(words), 3)})
text = ' '.join(part.get('text', '') for part in parts).strip()
print(json.dumps({'status': 'local-unverified', 'language': 'de', 'engine': 'vosk-small-de-0.15',
                  'text': text[:40000], 'segments': segments[:400]}, ensure_ascii=False))
