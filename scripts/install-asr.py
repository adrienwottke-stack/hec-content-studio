import pathlib
import urllib.request
import zipfile

root = pathlib.Path('/opt/asr-models')
root.mkdir(parents=True, exist_ok=True)
archive = root / 'model.zip'
urllib.request.urlretrieve('https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip', archive)
with zipfile.ZipFile(archive) as model:
    for entry in model.infolist():
        target = (root / entry.filename).resolve()
        if not target.is_relative_to(root.resolve()):
            raise ValueError('Model archive contains an invalid path')
    model.extractall(root)
archive.unlink()
