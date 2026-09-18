# Create Your First Notebook

1. Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` elsewhere).
2. Run **Create: New marimo notebook** and choose where to save it.
3. Select a Python environment with marimo installed, or choose **marimo sandbox**.
4. Add and run the following two cells:

```python
import marimo as mo

slider = mo.ui.slider(1, 100, value=50)
slider
```

```python
mo.md(f"The slider value is: {slider.value}")
```

Moving the slider automatically updates the second cell.

To open an existing marimo `.py` file, run **marimo: Open as marimo notebook**.
