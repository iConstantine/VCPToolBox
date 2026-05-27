import os
import re
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    print("【爱弥斯警告】请先在终端运行: pip install PyMuPDF")
    sys.exit(1)

# 1. 自动寻址：全盘搜索那个 3644 页的怪物 PDF
pdf_name = "1_卢麒元课程_001_227.pdf"
pdf_path = None
print(f"🔍 正在 VCP 工作区寻找 {pdf_name} ...")

# 强制使用绝对路径扫描，防止 CWD 陷阱！
workspace_root = r"D:\VCPToolBox-Official"

for root, dirs, files in os.walk(workspace_root):
    if "node_modules" in root or "VectorStore" in root:
        continue
    if pdf_name in files:
        pdf_path = os.path.join(root, pdf_name)
        break

if not pdf_path:
    print(f"❌ 找遍了也没找到 {pdf_name}！阿漂你是不是把名字记错了！")
    sys.exit(1)

print(f"✅ 找到目标：{pdf_path}")
print("⚙️ 开始降维打击：提取纯文本 (这可能需要几分钟，请耐心等待)...")

# 2. 降维提取纯文本
try:
    doc = fitz.open(pdf_path)
    full_text = ""
    for page in doc:
        full_text += page.get_text()
    doc.close()
except Exception as e:
    print(f"❌ PDF 读取失败：{e}")
    sys.exit(1)

print(f"✅ 文本提取完成！总长度: {len(full_text)} 个字符。")
print("🔪 开始执行正则锚点切片...")

# 3. 正则切肉机 (假设卢老师的课有日期或期数标记)
# 这里匹配常见的换行后紧跟年份，或者“第X期”的模式
pattern = r'\n(?=\s*(?:20\d{2}年\d{1,2}月\d{1,2}日|第\d{1,3}期|【第\d{1,3}期】))'
chunks = re.split(pattern, full_text)

if len(chunks) <= 1:
    print("⚠️ 警告：正则未命中锚点！PDF 可能没有标准的日期/期数开头。")
    print("🔄 触发优雅降级：按每 3000 字强制切分逻辑块...")
    chunks = [full_text[i:i+3000] for i in range(0, len(full_text), 3000)]

# 4. 自动化装罐 (生成 VCP 标准日记)
output_dir = os.path.join(workspace_root, "Raw_Lectures")
os.makedirs(output_dir, exist_ok=True)

count = 0
for i, chunk in enumerate(chunks):
    chunk = chunk.strip()
    if len(chunk) < 150:  # 忽略太短的无意义碎片
        continue
    
    # 伪造 VCP 日记标准头部
    vcp_content = f"[12:00]\n{chunk}"
    
    file_path = os.path.join(output_dir, f"Luqiyuan_Lecture_{count:03d}.txt")
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(vcp_content)
    count += 1

print("==================================================")
print(f"🎉 切片大功告成！共生成 {count} 个 VCP 标准日记雏形！")
print(f"📂 文件已保存在 {output_dir} 目录下。")
print("🚀 下一步：请运行 `node diary-tag-batch-processor.js ./Raw_Lectures` 启动打标工厂！")
print("==================================================")