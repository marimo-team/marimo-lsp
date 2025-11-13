# Create Your First Notebook

Ready to build something amazing? Creating a marimo notebook is easy!

## Two Ways to Create a Notebook

### Method 1: Command Palette (Recommended)

1. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
2. Type "marimo: New marimo notebook"
3. Choose a location and name for your notebook
4. Start coding!

### Method 2: File Explorer

1. Right-click in the Explorer
2. Select "New File"
3. Give it a `.py` extension
4. When you save, VS Code will prompt you to open it as a marimo notebook

## Your First Cells

Every marimo notebook starts with cells. Here's a simple example:

```python
import marimo as mo

# Create an interactive slider
slider = mo.ui.slider(1, 100, value=50)
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
