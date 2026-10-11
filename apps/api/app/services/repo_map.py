"""Repository-aware analysis: connect a screenshot's components to the source files that render them.

Input: a repository as a .zip (upload) or a public GitHub URL (downloaded as a zip). Nothing is executed.
Method (deterministic, no model call):
  1. Index UI-ish source files (jsx/tsx/js/ts/vue/svelte/html/templates/css), skipping vendored/build dirs.
  2. Visible text of each component (button labels, headings, links...) is searched in the source:
     an exact text hit is strong evidence (`observed`); a file/component name that matches the
     component's type or label is weaker (`inferred`).
  3. Relative imports become a file dependency graph; package.json reveals the framework.
The result is also returned as a SystemAnalysis (UI components + files, `implemented_in` + `imports`
edges) so the same grounded chat can answer "which file renders the Sign in button?".
"""

from __future__ import annotations

import io
import json
import posixpath
import re
import urllib.request
import zipfile
from collections import Counter, defaultdict
from typing import Any

from ..contract import Component, Provider, Relationship, Source, SystemAnalysis

MAX_ZIP_BYTES = 40 * 1024 * 1024
MAX_FILES = 4000
MAX_FILE_BYTES = 400 * 1024
SOURCE_EXT = {".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".html", ".htm", ".astro", ".hbs", ".ejs",
              ".jinja", ".j2", ".erb", ".php", ".mdx", ".dart", ".swift", ".kt", ".css", ".scss"}
TEXT_EXT = SOURCE_EXT - {".css", ".scss"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", ".venv", "venv",
             "__pycache__", ".turbo", ".cache", "public/build", "storybook-static", ".svelte-kit"}
FRAMEWORKS = [("next", "Next.js"), ("react", "React"), ("vue", "Vue"), ("nuxt", "Nuxt"), ("svelte", "Svelte"),
              ("@angular/core", "Angular"), ("solid-js", "Solid"), ("astro", "Astro"), ("tailwindcss", "Tailwind CSS"),
              ("@mui/material", "MUI"), ("styled-components", "styled-components"), ("react-router-dom", "React Router")]
_GH = re.compile(r"^https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?:/tree/([^?#]+))?/?$")
_IMPORT = re.compile(r"""(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*|import\s+)['"](\.{1,2}/[^'"]+|@/[^'"]+|~/[^'"]+)['"]""")
_DEF = re.compile(r"(?:export\s+(?:default\s+)?)?(?:function|class|const|let)\s+([A-Z][A-Za-z0-9_]*)\s*[=(:<{]")


class RepoError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def download_github_zip(url: str) -> tuple[bytes, str]:
    m = _GH.match(url.strip())
    if not m:
        raise RepoError("bad_repo_url", "Use a public GitHub URL like https://github.com/owner/repo")
    owner, repo, ref = m.group(1), m.group(2), m.group(3)
    refs = [f"refs/heads/{ref}"] if ref else ["refs/heads/main", "refs/heads/master"]
    for r in refs:
        req = urllib.request.Request(f"https://codeload.github.com/{owner}/{repo}/zip/{r}",
                                     headers={"User-Agent": "teardown-ai"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read(MAX_ZIP_BYTES + 1)
        except Exception:
            continue
        if len(data) > MAX_ZIP_BYTES:
            raise RepoError("repo_too_large", "That repository zip is larger than 40 MB.", 413)
        return data, f"{owner}/{repo}"
    raise RepoError("repo_not_found", "Could not download that repository (is it public, and is the branch main/master?).", 404)


def read_zip(data: bytes) -> dict[str, str]:
    if len(data) > MAX_ZIP_BYTES:
        raise RepoError("repo_too_large", "The repository zip must be 40 MB or smaller.", 413)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise RepoError("bad_zip", "That file is not a valid .zip archive.") from None
    names = [i for i in zf.infolist() if not i.is_dir()]
    # strip a single top-level folder (GitHub zips: repo-main/...)
    tops = {n.filename.split("/", 1)[0] for n in names if "/" in n.filename}
    strip = (tops.pop() + "/") if len(tops) == 1 and all("/" in n.filename for n in names) else ""
    files: dict[str, str] = {}
    for info in names:
        path = info.filename[len(strip):] if strip and info.filename.startswith(strip) else info.filename
        parts = path.split("/")
        if ".." in parts or path.startswith("/") or any(p in SKIP_DIRS for p in parts[:-1]):
            continue
        ext = posixpath.splitext(path)[1].lower()
        if ext not in SOURCE_EXT and parts[-1] != "package.json":
            continue
        if info.file_size > MAX_FILE_BYTES or ".min." in parts[-1]:
            continue
        try:
            files[path] = zf.read(info).decode("utf-8", errors="ignore")
        except Exception:
            continue
        if len(files) >= MAX_FILES:
            break
    if not files:
        raise RepoError("no_source", "No UI source files (jsx/tsx/vue/svelte/html/…) were found in that archive.")
    return files


def _best_occurrence(text: str, needle: str) -> int:
    """Index of the occurrence that looks like rendered text: between tags or inside a string literal."""
    best, best_score, i = -1, -1, text.find(needle)
    while i >= 0:
        before = text[i - 1] if i > 0 else " "
        after = text[i + len(needle)] if i + len(needle) < len(text) else " "
        score = (2 if before in ">\"'`" else 0) + (2 if after in "<\"'`" else 0) + (0 if before.isalnum() or after.isalnum() else 1)
        if score > best_score:
            best, best_score = i, score
        i = text.find(needle, i + 1)
    return best


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _resolve_import(src: str, spec: str, files: dict[str, str]) -> str | None:
    if spec.startswith(("@/", "~/")):
        base = "src/" + spec[2:] if any(p.startswith("src/") for p in files) else spec[2:]
    else:
        base = posixpath.normpath(posixpath.join(posixpath.dirname(src), spec))
    for cand in [base] + [base + e for e in (".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte", ".css", ".scss")] + \
                [base + "/index" + e for e in (".tsx", ".ts", ".jsx", ".js", ".vue")]:
        if cand in files:
            return cand
    return None


def map_repository(analysis: SystemAnalysis, files: dict[str, str], repo_name: str) -> tuple[dict[str, Any], SystemAnalysis]:
    code = {p: t for p, t in files.items() if posixpath.splitext(p)[1].lower() in TEXT_EXT}
    lowered = {p: t.lower() for p, t in code.items()}
    lines_of = {p: t.splitlines() for p, t in code.items()}
    defs: dict[str, list[str]] = {p: sorted(set(_DEF.findall(t)))[:20] for p, t in code.items()}

    # framework
    frameworks: list[str] = []
    for p, t in files.items():
        if p.endswith("package.json") and p.count("/") <= 2:
            try:
                pkg = json.loads(t)
            except ValueError:
                continue
            deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
            frameworks += [name for key, name in FRAMEWORKS if key in deps and name not in frameworks]
    if not frameworks:
        exts = Counter(posixpath.splitext(p)[1] for p in code)
        frameworks = ["Vue" if exts[".vue"] else "Svelte" if exts[".svelte"] else "HTML/JS"]

    # 1) visible text -> files
    mappings = []
    by_file: dict[str, set[str]] = defaultdict(set)
    for c in analysis.components:
        label = _norm(c.label)
        hits = []
        if 3 <= len(label) <= 80 and not label.startswith(("top ", "left ", "main ")):
            for p, low in lowered.items():
                i = _best_occurrence(low, label)
                if i < 0:
                    continue
                ln = low.count("\n", 0, i)
                snippet = lines_of[p][ln].strip()[:160] if ln < len(lines_of[p]) else ""
                hits.append({"path": p, "line": ln + 1, "snippet": snippet, "reason": f"Visible text “{c.label[:50]}” appears in the source",
                             "status": "observed"})
        # 2) name match: component/file named like the element (NavBar.tsx for a navbar, LoginForm for a login form)
        words = [w for w in re.findall(r"[a-z]+", (c.label + " " + c.type).lower()) if len(w) > 2 and w not in {"the", "and", "section", "container", "text"}]
        if c.type in {"navbar", "header", "footer", "sidebar", "hero", "card", "form", "modal", "table", "chart", "search", "tabs", "menu"}:
            for p in code:
                stem = re.sub(r"[^a-z]", "", posixpath.basename(p).split(".")[0].lower())
                names = [re.sub(r"[^a-z]", "", d.lower()) for d in defs.get(p, [])] + [stem]
                key = {"navbar": ("nav", "navbar", "navigation", "topbar", "header"), "sidebar": ("sidebar", "sidenav", "drawer")}.get(c.type, (c.type,))
                if any(any(n == k or n.endswith(k) or n.startswith(k) for k in key) for n in names if n) and \
                        not any(h["path"] == p for h in hits):
                    named = next((d for d in defs.get(p, []) if any(k in d.lower() for k in key)), posixpath.basename(p))
                    hits.append({"path": p, "line": None, "snippet": f"{named}", "reason": f"Component/file name matches a {c.type}",
                                 "status": "inferred"})
        hits.sort(key=lambda h: (h["status"] != "observed", h["path"].endswith((".html", ".htm")) and len(hits) > 1, len(h["path"])))
        hits = hits[:5]
        for h in hits:
            by_file[h["path"]].add(c.id)
        if hits:
            mappings.append({"componentId": c.id, "label": c.label, "matches": hits})

    # 3) import graph (only among files that matter: matched files + their neighbours)
    imports = []
    for p, t in code.items():
        for spec in _IMPORT.findall(t):
            tgt = _resolve_import(p, spec, files)
            if tgt and tgt != p:
                imports.append({"from": p, "to": tgt})
    imports = [dict(t) for t in {tuple(sorted(i.items())) for i in imports}]
    importers = Counter(i["to"] for i in imports)

    # structure summary
    top = Counter(p.split("/")[0] if "/" in p else "(root)" for p in code)
    pages = sorted(p for p in code if re.search(r"(^|/)(pages|app|routes|views|screens)/", p))[:30]
    comp_files = sorted((p for p in code if defs.get(p) and re.search(r"(^|/)components?/", p)), key=lambda p: -importers[p])[:30]
    mapped = len(mappings)
    observed = sum(any(h["status"] == "observed" for h in m["matches"]) for m in mappings)
    summary = (f"{repo_name}: {len(code)} UI source files ({', '.join(frameworks)}). "
               f"{observed} of {len(analysis.components)} screen components were found by their visible text"
               + (f", {mapped - observed} more by component name." if mapped > observed else "."))

    # chat-able SystemAnalysis: UI components + files
    rel_files = sorted(by_file, key=lambda p: (-len(by_file[p]), p))[:40]
    keep = set(rel_files)
    fid = {p: "file:" + re.sub(r"[^a-zA-Z0-9_.-]+", "-", p)[:110] for p in rel_files}
    comps = [Component(id=c.id, label=c.label, type=c.type, status=c.status, evidence=c.evidence[:2], bbox=c.bbox)
             for c in analysis.components]
    comps += [Component(id=fid[p], label=p, type="file", status="observed",
                        evidence=[f"Defines: {', '.join(defs.get(p, [])[:6]) or '—'}", f"Imported by {importers[p]} file(s)"])
              for p in rel_files]
    rels: list[Relationship] = []
    seen: set[str] = set()
    for m in mappings:
        for h in m["matches"]:
            if h["path"] not in fid:
                continue
            rid = f"{m['componentId']}--implemented_in--{fid[h['path']]}"
            if rid in seen:
                continue
            seen.add(rid)
            rels.append(Relationship(id=rid, **{"from": fid[h["path"]]}, to=m["componentId"], type="implemented_in",
                                     status=h["status"], evidence=[h["reason"] + (f" (line {h['line']})" if h["line"] else "")]))
    for i in imports:
        if i["from"] in fid and i["to"] in fid:
            rid = f"{fid[i['to']]}--imports--{fid[i['from']]}"
            if rid not in seen:
                seen.add(rid)
                rels.append(Relationship(id=rid, **{"from": fid[i["to"]]}, to=fid[i["from"]], type="depends_on",
                                         status="observed", evidence=[f"{i['from']} imports {i['to']}"]))
    repo_analysis = SystemAnalysis(
        analysisId=f"repo-{analysis.analysisId}", domain="digital", title=f"Source map: {analysis.title} ↔ {repo_name}",
        source=Source(kind="repository", filename=repo_name), components=comps, relationships=rels, summary=summary,
        limitations=[
            "Matches are text and name based; a label built at runtime (i18n keys, data from an API) will not be found.",
            "The same text can appear in several files (tests, stories); the most specific UI file is listed first.",
            "No code was executed; the import graph covers relative and @/ imports only.",
        ],
        provider=Provider(name="deterministic", model="text-match+imports"),
    )
    result = {
        "repo": repo_name, "frameworks": frameworks, "fileCount": len(code), "summary": summary,
        "mappings": mappings, "imports": [i for i in imports if i["from"] in keep or i["to"] in keep][:200],
        "structure": {"topLevel": dict(top.most_common(12)), "pages": pages, "componentFiles": comp_files},
        "unmapped": [c.id for c in analysis.components if c.id not in {m["componentId"] for m in mappings}],
        "analysisId": repo_analysis.analysisId, "limitations": repo_analysis.limitations,
    }
    return result, repo_analysis
