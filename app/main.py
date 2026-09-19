"""平面照片标尺校准 Web 应用 —— FastAPI 后端。

负责：
* 接收并校验用户上传的本地照片（限制类型与大小）；
* 读取照片像素尺寸返回给前端；
* 提供上传文件与前端静态资源托管。

透视校准、多边形面积/周长等几何计算全部在前端完成（见 static/app.js），
导出测量 JSON 也由浏览器端生成，后端保持无状态、易水平扩展。
"""

import io
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB

app = FastAPI(title="平面照片标尺校准", version="1.0.0")


@app.get("/api/health")
def health() -> dict:
    """健康检查，方便容器编排探活。"""
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_photo(file: UploadFile = File(...)) -> dict:
    """接收一张照片，返回其访问 URL 与原始像素宽高。"""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="仅支持 image/* 图片文件")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的图片格式 {suffix or '(无扩展名)'}，"
            f"允许：{', '.join(sorted(ALLOWED_SUFFIXES))}",
        )

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="图片过大，上限为 25 MiB")

    try:
        # verify() 会校验文件是否真的是图片；校验后需要重新打开才能读取尺寸。
        Image.open(io.BytesIO(data)).verify()
        with Image.open(io.BytesIO(data)) as im:
            width, height = im.size
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="无法解析的图片文件") from exc

    stored_name = f"{uuid.uuid4().hex[:12]}{suffix}"
    (UPLOAD_DIR / stored_name).write_bytes(data)

    return {
        "id": stored_name.removesuffix(suffix),
        "url": f"/uploads/{stored_name}",
        "filename": file.filename,
        "width": width,
        "height": height,
    }


# 上传文件与前端静态资源。html=True 让根路径返回 index.html。
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
