import type * as vscode from "vscode";

type FilenameValidation =
  | { problematic: true; message: string }
  | { problematic: false };

/**
 * Module names that must not be used as notebook filenames.
 * Includes marimo itself and Python standard library modules.
 *
 * Generated from `sys.stdlib_module_names` (Python 3.12) plus marimo.
 */
// prettier-ignore
const SHADOWED_MODULES = new Set([
  "marimo",
  // Python stdlib
  "__future__", "_thread", "abc", "aifc", "argparse", "array", "ast",
  "asynchat", "asyncio", "asyncore", "atexit", "audioop", "base64",
  "bdb", "binascii", "binhex", "bisect", "builtins", "bz2", "calendar",
  "cgi", "cgitb", "chunk", "cmath", "cmd", "code", "codecs", "codeop",
  "collections", "colorsys", "compileall", "concurrent", "configparser",
  "contextlib", "contextvars", "copy", "copyreg", "cProfile", "crypt",
  "csv", "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal",
  "difflib", "dis", "distutils", "doctest", "email", "encodings",
  "enum", "errno", "faulthandler", "fcntl", "filecmp", "fileinput",
  "fnmatch", "fractions", "ftplib", "functools", "gc", "getopt",
  "getpass", "gettext", "glob", "graphlib", "grp", "gzip", "hashlib",
  "heapq", "hmac", "html", "http", "idlelib", "imaplib", "imghdr",
  "imp", "importlib", "inspect", "io", "ipaddress", "itertools", "json",
  "keyword", "lib2to3", "linecache", "locale", "logging", "lzma",
  "mailbox", "mailcap", "marshal", "math", "mimetypes", "mmap",
  "modulefinder", "multiprocessing", "netrc", "nis", "nntplib",
  "numbers", "operator", "optparse", "os", "ossaudiodev", "pathlib",
  "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform",
  "plistlib", "poplib", "posix", "posixpath", "pprint", "profile",
  "pstats", "pty", "pwd", "py_compile", "pyclbr", "pydoc", "queue",
  "quopri", "random", "re", "readline", "reprlib", "resource",
  "rlcompleter", "runpy", "sched", "secrets", "select", "selectors",
  "shelve", "shlex", "shutil", "signal", "site", "smtpd", "smtplib",
  "sndhdr", "socket", "socketserver", "spwd", "sqlite3", "sre_compile",
  "sre_constants", "sre_parse", "ssl", "stat", "statistics", "string",
  "stringprep", "struct", "subprocess", "sunau", "symtable", "sys",
  "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile",
  "termios", "test", "textwrap", "threading", "time", "timeit",
  "tkinter", "token", "tokenize", "tomllib", "trace", "traceback",
  "tracemalloc", "tty", "turtle", "turtledemo", "types", "typing",
  "unicodedata", "unittest", "urllib", "uu", "uuid", "venv", "warnings",
  "wave", "weakref", "webbrowser", "winreg", "winsound", "wsgiref",
  "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib",
  "_abc", "_bisect", "_codecs", "_collections_abc", "_csv", "_datetime",
  "_decimal", "_heapq", "_io", "_json", "_operator", "_pickle",
  "_random", "_signal", "_sre", "_stat", "_string", "_struct",
  "_symtable", "_threading_local", "_tracemalloc", "_weakref",
]);

/**
 * Check if a URI points to a file that shadows a Python module.
 */
export function isProblematicFilename(uri: vscode.Uri): FilenameValidation {
  const basename = uri.path.split("/").pop() ?? "";
  if (!basename.endsWith(".py")) {
    return { problematic: false };
  }

  const moduleName = basename.slice(0, -3);
  if (SHADOWED_MODULES.has(moduleName)) {
    return {
      problematic: true,
      message:
        moduleName === "marimo"
          ? `Your notebook is named '${basename}', which shadows the marimo package and will prevent it from running. Please consider renaming your file.`
          : `Your notebook is named '${basename}', which shadows the Python built-in '${moduleName}' module. Please consider renaming your file.`,
    };
  }
  return { problematic: false };
}
