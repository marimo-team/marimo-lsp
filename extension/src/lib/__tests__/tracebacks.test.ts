import { describe, expect, it } from "vitest";

import { parseTraceback } from "../tracebacks.ts";

const stripAnsi = (s: string) => s.replace(/\u001b\[[\d;]*m/g, "");

describe("parseTraceback", () => {
  it("strips pygments wrapper, rewrites frames to IPython shape, and extracts name/message", () => {
    const html = `<div class="highlight"><pre><span class="gt">Traceback (most recent call last):</span>
  File <span class="s">&quot;/Users/me/proj/foo.py&quot;</span>, line <span class="m">42</span>, in <span class="nb">&lt;module&gt;</span>
    foo()
<span class="ne">NameError</span>: name &#39;x&#39; is not defined
</pre></div>`;
    expect(parseTraceback(html)).toMatchInlineSnapshot(`
    	{
    	  "message": "name 'x' is not defined",
    	  "name": "NameError",
    	  "stack": "Traceback (most recent call last):
    	  File <a href="/Users/me/proj/foo.py:42">/Users/me/proj/foo.py:42</a>[2m, in <module>[0m
    	    foo()
    	[1;31mNameError[0m: name 'x' is not defined",
    	}
    `);
  });

  it("handles cell-temp file frames with no mapper (cell-?)", () => {
    const html = `Traceback (most recent call last):
  File &quot;/var/folders/zz/abc/T/__marimo__cell_AbCd_.py&quot;, line 1, in &lt;module&gt;
    1/0
ZeroDivisionError: division by zero`;
    expect(parseTraceback(html)).toMatchInlineSnapshot(`
    	{
    	  "message": "division by zero",
    	  "name": "ZeroDivisionError",
    	  "stack": "Traceback (most recent call last):
    	  Cell [36mcell-?[0m[2m, line 1[0m
    	    1/0
    	[1;31mZeroDivisionError[0m: division by zero",
    	}
    `);
  });

  it("resolves cell-temp frames to cell-<index+1> via mapper", () => {
    const html = `Traceback (most recent call last):
  File &quot;/var/folders/zz/abc/T/__marimo__cell_AbCd_.py&quot;, line 3, in &lt;module&gt;
    kaboom()
ZeroDivisionError: division by zero`;
    const cellIdToIndex = (id: string) => (id === "AbCd" ? 1 : undefined);
    const out = parseTraceback(html, cellIdToIndex);
    expect(stripAnsi(out.stack)).toContain("Cell cell-2, line 3");
  });

  it("handles chained exceptions (during handling)", () => {
    const html = `Traceback (most recent call last):
  File &quot;/a.py&quot;, line 3, in &lt;module&gt;
KeyError: 'k'

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File &quot;/b.py&quot;, line 5, in &lt;module&gt;
ValueError: bad`;
    const out = parseTraceback(html);
    expect(out.name).toBe("ValueError");
    expect(out.message).toBe("bad");
    expect(out.stack).toContain('<a href="/a.py:3">');
    expect(out.stack).toContain('<a href="/b.py:5">');
  });

  it("handles chained exceptions (the above was the direct cause)", () => {
    const html = `Traceback (most recent call last):
  File &quot;/x.py&quot;, line 1
TypeError: a

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File &quot;/y.py&quot;, line 2
RuntimeError: b`;
    const out = parseTraceback(html);
    expect(out.name).toBe("RuntimeError");
    expect(out.message).toBe("b");
  });

  it("handles exceptions with no message", () => {
    const html = `Traceback (most recent call last):
  File &quot;/a.py&quot;, line 1, in &lt;module&gt;
StopIteration`;
    expect(parseTraceback(html)).toMatchInlineSnapshot(`
    	{
    	  "message": "",
    	  "name": "StopIteration",
    	  "stack": "Traceback (most recent call last):
    	  File <a href="/a.py:1">/a.py:1</a>[2m, in <module>[0m
    	[1;31mStopIteration[0m",
    	}
    `);
  });

  it("handles dotted exception names (qualified types)", () => {
    const html = `Traceback (most recent call last):
  File &quot;/a.py&quot;, line 1
my.pkg.CustomError: oops`;
    const out = parseTraceback(html);
    expect(out.name).toBe("my.pkg.CustomError");
    expect(out.message).toBe("oops");
  });

  it("returns empty name/message when the input is not a traceback", () => {
    expect(parseTraceback("<p>not a traceback</p>")).toMatchInlineSnapshot(`
    	{
    	  "message": "",
    	  "name": "not a traceback",
    	  "stack": "not a traceback",
    	}
    `);
  });
});
