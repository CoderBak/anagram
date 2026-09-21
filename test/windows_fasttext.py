"""Small Windows language-gate smoke; no EditLens download or browser registration."""
import hashlib
from pathlib import Path
import tempfile
import urllib.request
import fasttext

URL = 'https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz'
SHA = '8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83'
with tempfile.TemporaryDirectory(prefix='anagram-language-test-') as folder:
    model = Path(folder) / 'lid.176.ftz'
    data = urllib.request.urlopen(URL, timeout=60).read()
    assert hashlib.sha256(data).hexdigest() == SHA
    model.write_bytes(data)
    gate = fasttext.load_model(str(model))
    # Same pybind API as LanguageGate; avoids old wrapper's NumPy 2 copy=False bug.
    for text, expected in [('This is a complete English paragraph about reading a book in the library.', '__label__en'),
                           ('这是一个中文段落，我们正在测试本地语言识别功能。', '__label__zh')]:
        predictions = gate.f.predict(text, 1, 0.0, 'strict')
        assert predictions and predictions[0][1] == expected, predictions
        assert 0 < predictions[0][0] <= 1
print('PASS fasttext-wheel import and pinned lid.176 English/Chinese inference')
