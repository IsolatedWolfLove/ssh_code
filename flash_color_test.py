"""
显示管线自检脚本：不依赖摄像头，用纯色帧测试 cv2.imshow 是否能正常刷新画面。

用法：
    python3 flash_color_test.py
按 q 或 ESC 退出。
"""

import cv2
import numpy as np

WINDOW_NAME = "Color Flash Test"
WIDTH, HEIGHT = 640, 480
INTERVAL_MS = 500  # 每种颜色显示的时长(毫秒)

# BGR 顺序（OpenCV 默认），依次为：红、黄、绿
COLORS = [
    ("RED", (0, 0, 255)),
    ("YELLOW", (0, 255, 255)),
    ("GREEN", (0, 255, 0)),
]


def make_frame(color_bgr, label):
    frame = np.full((HEIGHT, WIDTH, 3), color_bgr, dtype=np.uint8)
    cv2.putText(
        frame,
        label,
        (30, 60),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.2,
        (0, 0, 0),
        3,
        cv2.LINE_AA,
    )
    return frame


def main():
    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
    idx = 0
    frame_count = 0
    while True:
        label, color = COLORS[idx % len(COLORS)]
        frame = make_frame(color, label)

        cv2.imshow(WINDOW_NAME, frame)
        frame_count += 1
        print(f"[frame {frame_count}] showing {label}")

        key = cv2.waitKey(INTERVAL_MS) & 0xFF
        if key in (ord("q"), 27):  # q 或 ESC 退出
            break

        idx += 1

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
