"""Smart Scene detection — histogram difference (preserved from the Tkinter app)."""

import cv2


def hist_diff(prev_gray, curr_gray) -> float:
    """Bhattacharyya distance between 64-bin grayscale histograms, scaled to 0-100."""
    h1 = cv2.calcHist([prev_gray], [0], None, [64], [0, 256])
    h2 = cv2.calcHist([curr_gray], [0], None, [64], [0, 256])
    cv2.normalize(h1, h1)
    cv2.normalize(h2, h2)
    return cv2.compareHist(h1, h2, cv2.HISTCMP_BHATTACHARYYA) * 100.0
