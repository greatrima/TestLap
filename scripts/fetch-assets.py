"""Download pinned public OCR assets; never handles user images."""
import concurrent.futures, hashlib, json, pathlib, urllib.request
import yaml

root = pathlib.Path(__file__).resolve().parents[1] / 'dist'
rec_rev = '5c6f574b8e2230adf4287b33e736d71b9fabd28e'
det_rev = 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d'
assets = {
 'models/korean-rec.onnx': f'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/{rec_rev}/inference.onnx',
 'models/text-det.onnx': f'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/{det_rev}/inference.onnx',
 'models/korean-inference.yml': f'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/{rec_rev}/inference.yml',
 'vendor/ort.wasm.min.js':'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js',
 'vendor/ort-wasm-simd-threaded.mjs':'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs',
 'vendor/ort-wasm-simd-threaded.wasm':'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm',
 'vendor/tesseract.min.js':'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
 'vendor/worker.min.js':'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
 'vendor/tesseract-core-simd-lstm.wasm.js':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js',
 'vendor/tesseract-core-simd-lstm.wasm':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm',
 'vendor/tesseract-core-lstm.wasm.js':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm.js',
 'vendor/tesseract-core-lstm.wasm':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm',
 'models/kor.traineddata.gz':'https://tessdata.projectnaptha.com/4.0.0/kor.traineddata.gz',
 'models/eng.traineddata.gz':'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
}
def download(item):
 name,url=item; path=root/name; path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():
  with urllib.request.urlopen(url,timeout=90) as res: data=res.read()
  path.write_bytes(data)
 data=path.read_bytes()
 print(name,len(data),flush=True)
 return {'path':'./'+name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'source':url}
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
 records=list(pool.map(download,assets.items()))
config=yaml.safe_load((root/'models/korean-inference.yml').read_text())
chars=config['PostProcess']['character_dict']
(root/'models/korean-dict.json').write_text(json.dumps(['']+chars+[' '],ensure_ascii=False))
(root/'assets-manifest.json').write_text(json.dumps(records,indent=2))
print('character count:',len(chars)+2,flush=True)
