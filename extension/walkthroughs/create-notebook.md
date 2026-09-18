# Create Your First Notebook

Ready to build something amazing? Creating a marimo notebook is easy!

## Two Ways to Create a Notebook

### Method 1: Command Palette (Recommended)

1. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
2. Run "Create: New marimo notebook"
3. Choose a location and name for your notebook
4. Select a Python environment with marimo installed, or choose **marimo sandbox**
5. Start coding and run a cell

### Method 2: File Menu

1. Open **File > New File...**
2. Select **Marimo notebook**
3. Choose a location and name for your notebook

To open an existing marimo `.py` file, use **marimo: Open as marimo notebook**
from the command palette or the notebook icon in the editor title bar. An empty
`.py` file is not automatically a marimo notebook.

## Your First Cells

Every marimo notebook starts with cells. Here's a simple example:

```python
import marimo as mo

# Create an interactive slider
slider = mo.ui.slider(1, 100, value=50)
slider
```

```python
# Display the slider and show its value
mo.md(f"The slider value is: {slider.value}")
```

Notice how changing the slider automatically updates the dependent cell? That's marimo's reactivity in action!

## Key Features to Explore

- **Interactive UI Elements**: Use `mo.ui.*` to create sliders, text inputs, dropdowns, and more
- **Rich Markdown**: Use `mo.md()` for formatted text with LaTeX support
- **Data Visualization**: Create plots with matplotlib, plotly, altair, and more
- **Variables Explorer**: View all variables in the marimo panel at the bottom

Click the button above to create your first notebook!
