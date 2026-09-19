# 平面照片标尺校准（Photo Planar Ruler）

在斜拍的平面照片上，用一个**已知实际宽高的矩形**（如 A4 纸、地砖、标定卡）完成透视校准，
随后在画布上绘制任意闭合多边形，实时得到**校正后的实际面积与周长**。

技术栈：**FastAPI**（上传/静态托管）+ **原生 HTML/CSS/JavaScript Canvas**（无前端构建、无第三方 JS 依赖）。几何计算全部在浏览器端完成。

---

## 一条命令启动

```bash
docker compose up --build
```

启动后浏览器访问：

> **http://localhost:8000**

- 端口映射：宿主 `8000` → 容器 `8000`（在 `docker-compose.yml` 的 `ports` 中可改）。
- 上传的照片保存在 Docker 卷 `uploads_data`（容器内 `/srv/app/app/uploads`），重建容器不丢失。
- 停止：`docker compose down`（加 `-v` 同时删除已上传照片）。

### 不用 Docker 时（本地开发）

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

同样访问 http://localhost:8000 。

---

## 使用步骤

1. **打开照片**：点击右上角「打开照片」，或直接把 JPG / PNG / WebP / BMP 拖入画布（≤ 25 MiB）。
2. **标记标定矩形**：在侧栏填写矩形的实际宽、高（单位：米），然后在照片上严格按
   **左上 → 右上 → 右下 → 左下** 的顺序点击四个角。
   - 校准成功后状态栏变绿，角点可随时**拖动微调**，所有测量会实时重算。
3. **绘制测量区域**：点击「新建 / 重画区域」，在画布上单击逐点描边；
   **双击**或点击带 ✓ 的首顶点即可闭合。可画多个区域。
4. 画布与列表中实时显示每个区域校正后的**面积**与**周长**（自动在 m / cm / mm、m² / cm² / mm² 间换算）。
5. 点击「导出测量 JSON」下载包含照片信息、四点像素坐标、单应矩阵、各区域像素/世界坐标与结果的文件。

### 画布操作

| 操作 | 方式 |
| --- | --- |
| 缩放 | 鼠标滚轮（以光标为中心）／右下角 ± 按钮／双指捏合 |
| 平移 | 空白处按住拖动（小幅移动仍视为点击），或按住空格拖动 / 鼠标中键 |
| 调整顶点 | 直接拖动任意标定角点或多边形顶点，测量实时更新 |
| 删除区域 | 选中后点「删除选中区域」，或按 `Delete` / `Backspace` |
| 重画区域 | 选中区域后点「重画选中区域」，清空其顶点重新描边（名称、颜色保留）；闭合状态下也可直接拖点修改 |
| 取消绘制 | 未闭合时按 `Esc` |
| 视图复位 | 顶栏「视图复位」（不影响任何测量坐标） |

---

## 测量原理

1. 设照片平面像素坐标为 `p = (x, y, 1)`，真实平面（米）坐标为 `P = (X, Y, 1)`，
   两者满足透视关系 `P ∝ H · p`。
2. 4 个矩形角点与其世界角点 `(0,0) (W,0) (W,H) (0,H)` 构成 4 对点，
   用 **DLT（直接线性变换）** 建立 8×9 齐次方程组，
   通过 **Jacobi 特征分解求 AᵀA 的最小特征向量**得到单应矩阵 `H` 的 9 个参数。
3. 多边形所有顶点经 `H` 投影到真实平面后：
   - 面积：**鞋带公式**（Shoelace）；
   - 周长：相邻世界坐标点欧氏距离之和；
   - 自交检测：任意两条非相邻边求交（含端点接触与共线重叠）。
4. 前端区分两套坐标：**图像坐标**（像素，测量唯一依据，不随视图改变）与
   **屏幕坐标**（`screen = image × scale + offset`），因此缩放、平移、拖顶点、窗口缩放（含高分屏 DPR）结果始终一致。

### 阻止计算的情形与提示

- 实际宽/高为空或非正数；角点不足 4 个。
- 角点**重合**或近似共线、不构成凸四边形（点击顺序错误导致交叉）。
- 单应矩阵**不可逆 / 透视分母为 0**，或正算校验残差过大 —— 状态栏给出具体原因。
- 多边形**自交**、存在重合顶点、跨越透视消失线附近 —— 该区域标红并在列表与画布标注原因（不影响其他区域）。

---

## 导出 JSON 示例

```json
{
  "app": "photo-planar-ruler",
  "schemaVersion": 1,
  "exportedAt": "2026-09-19T08:00:00.000Z",
  "image": { "filename": "floor.jpg", "widthPx": 4032, "heightPx": 3024, "url": "/uploads/xxx.jpg" },
  "calibration": {
    "referenceRectangle": { "widthM": 0.297, "heightM": 0.21 },
    "cornerOrder": "top-left -> top-right -> bottom-right -> bottom-left",
    "cornersImagePx": [{ "x": 520.1, "y": 380.6 }],
    "valid": true,
    "error": null,
    "homographyImageToWorld": [[0.000231, 0.000012, -0.118], [0.000009, 0.000255, -0.097], [0.0000001, 0.0000003, 1.0]]
  },
  "regions": [
    {
      "name": "区域 1",
      "closed": true,
      "verticesImagePx": [{ "x": 100, "y": 100 }],
      "verticesWorldM": [{ "x": 0.02, "y": 0.01 }],
      "areaM2": 0.1248,
      "perimeterM": 1.413,
      "error": null
    }
  ]
}
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/upload` | `multipart/form-data`，字段 `file`；返回 `{url, width, height, filename}` |
| `GET` | `/api/health` | 健康检查（容器 HEALTHCHECK 使用） |
| `GET` | `/uploads/<id>` | 访问已上传照片 |
| `GET` | `/` | 前端页面 |

## 项目结构

```
.
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── README.md
└── app
    ├── main.py            # FastAPI：上传校验、尺寸读取、静态托管
    └── static
        ├── index.html     # 侧栏 + 画布布局
        ├── style.css
        └── app.js         # DLT 透视校准、坐标变换、绘制/测量/导出
```
