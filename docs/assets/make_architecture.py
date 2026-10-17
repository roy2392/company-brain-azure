"""Build docs/assets/architecture.svg, an Azure-style architecture diagram with the official icons inlined.
   python3 docs/assets/make_architecture.py docs/assets/logos docs/assets/architecture.svg"""
import re
import sys
from pathlib import Path

LOGOS = Path(sys.argv[1])
OUT = Path(sys.argv[2])
FONT = "Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif"
n = 0


def icon(name, x, y, size, height=None):
    """Inline one icon file as a nested <svg>, ids prefixed so icons never collide."""
    global n
    n += 1
    src = (LOGOS / f"{name}.svg").read_text()
    vb = re.search(r'viewBox="([^"]+)"', src).group(1)
    inner = src[src.index(">", src.index("<svg")) + 1 : src.rindex("</svg>")]
    inner = re.sub(r"<title>.*?</title>", "", inner)
    p = f"i{n}-"
    inner = re.sub(r'id="([^"]+)"', lambda m: f'id="{p}{m.group(1)}"', inner)
    inner = re.sub(r"url\(#([^)]+)\)", lambda m: f"url(#{p}{m.group(1)})", inner)
    h = height or size
    return f'<svg x="{x}" y="{y}" width="{size}" height="{h}" viewBox="{vb}">{inner}</svg>'


def text(x, y, s, size=18, weight=400, fill="#1B2A35", anchor="start"):
    s = s.replace("&", "&amp;")
    return f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{s}</text>'


def box(x, y, w, h, fill="#FFFFFF", stroke="#D5DEE5", r=14, dash=None, sw=1.5):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>'


def arrow(x1, y1, x2, y2, color="#0078D4", both=False):
    m = ' marker-start="url(#ah-s)"' if both else ""
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2.5"{m} marker-end="url(#ah)"/>'


W, H = 1600, 940
e = []
e.append(f'<rect width="{W}" height="{H}" rx="20" fill="#FFFFFF"/>')
e.append(box(1, 1, W - 2, H - 2, fill="none", stroke="#E3E9EE", r=20))

# Wisteria systems (Era by Eon)
e.append(box(30, 170, 270, 430, fill="#F7F9FB"))
e.append(text(50, 208, "Wisteria systems", 21, 600))
e.append(text(50, 234, "Era by Eon · read-only REST + MCP", 15, 400, "#5B6B77"))
for i, (name, color) in enumerate([("Salesforce", "#00A1E0"), ("Zendesk", "#03363D"), ("Gong", "#8039DF"), ("Slack", "#E01E5A"), ("Jira &amp; Confluence", "#0052CC"), ("Google Drive", "#1FA463")]):
    yy = 280 + i * 50
    e.append(f'<circle cx="62" cy="{yy - 6}" r="8" fill="{color}"/>')
    e.append(text(82, yy, name.replace("&amp;", "&"), 18))

# Azure region
e.append(box(340, 40, 1230, 870, fill="#F3F8FD", stroke="#0078D4", r=18, dash="8 6"))
e.append(icon("microsoft", 362, 58, 26))
e.append(text(398, 79, "Microsoft Azure · Sweden Central", 21, 600, "#0B5CA8"))

# Resource group (Terraform)
e.append(box(360, 104, 820, 786, fill="#FFFFFF", stroke="#9AA9B5", r=14, dash="6 5"))
e.append(text(380, 134, "Resource group · created by Terraform (azurerm, azapi)", 16, 600, "#5B6B77"))

# Foundry
e.append(box(388, 156, 320, 330, fill="#EEF5FC", stroke="#0078D4"))
e.append(icon("foundry", 406, 172, 40))
e.append(text(456, 199, "Microsoft Foundry", 21, 600))
e.append(text(406, 236, "project wisteria-agents · gpt-5.4", 16, 400, "#3E5060"))
for i, a in enumerate(["Support Lead", "Account Manager", "RevOps Analyst", "Product Lead"]):
    yy = 256 + i * 52
    e.append(box(406, yy, 284, 40, fill="#FFFFFF", stroke="#B9D6F2", r=10))
    e.append(icon("foundry-agents", 416, yy + 7, 26))
    e.append(text(452, yy + 27, a + " agent", 17, 500))

# Application Insights
e.append(box(388, 514, 320, 120, fill="#F6F2FD", stroke="#8C6CE6"))
e.append(icon("app-insights", 406, 532, 40))
e.append(text(456, 558, "Application Insights", 20, 600))
e.append(text(406, 600, "Foundry tracing: every run and", 16, 400, "#3E5060"))
e.append(text(406, 622, "MCP tool call, with Log Analytics", 16, 400, "#3E5060"))

# Terraform note
e.append(box(388, 666, 320, 196, fill="#F8F5FD", stroke="#B9A2E8"))
e.append(icon("terraform", 406, 684, 36))
e.append(text(452, 709, "Terraform", 20, 600))
for i, line in enumerate(["network + NSG (NIC and subnet)", "Foundry, model, 8 MCP connections", "tracing, VM, identity, secrets", "Atlas project, cluster, user"]):
    e.append(text(406, 748 + i * 28, "· " + line, 16, 400, "#3E5060"))

# VM with containers
e.append(box(740, 156, 420, 706, fill="#F7F9FB", stroke="#0078D4"))
e.append(icon("azure-vm", 758, 172, 40))
e.append(text(808, 199, "Virtual machine", 21, 600))
e.append(text(808, 222, "Docker Compose", 16, 400, "#5B6B77"))
rows = [
    ("Caddy", "TLS · a key per agent", "#E8EEF3", None),
    ("Brain gateway", "MCP: brain tools, team memory, OM proxy", "#E8EEF3", None),
    ("agent-memory", "shared memory API (mongodb-partners)", "#E3F8EC", "mongodb-leaf-forest"),
    ("Atlas Local 8.3", "wisteria_brain: docs, entities, chunks", "#E3F8EC", "mongodb-leaf-forest"),
    ("OpenMetadata 2.0.5", "catalog, glossary, lineage, its MCP", "#EFEAFD", "openmetadata"),
    ("Postgres · Elasticsearch · Fuseki", "OpenMetadata storage, search, RDF", "#EFEAFD", None),
    ("Ollama", "embeddings + memory enrichment", "#E8EEF3", None),
    ("Portal browser", "noVNC · records the demo", "#E8EEF3", None),
]
for i, (name, sub, fill, logo) in enumerate(rows):
    yy = 246 + i * 76
    e.append(box(758, yy, 384, 64, fill=fill, stroke="none", r=10))
    tx = 772
    if logo:
        e.append(icon(logo, 768, yy + 16, 30 if logo != "openmetadata" else 26, 32 if logo == "openmetadata" else None))
        tx = 806
    e.append(text(tx, yy + 27, name, 17, 600))
    e.append(text(tx, yy + 50, sub, 15, 400, "#4D5E6B"))

# MongoDB Atlas cluster
e.append(box(1212, 156, 340, 300, fill="#EDFAF2", stroke="#00684A", sw=2))
e.append(icon("mongodb-leaf-forest", 1228, 170, 44))
e.append(text(1278, 199, "MongoDB Atlas", 22, 700, "#00684A"))
e.append(text(1228, 240, "M10 cluster on Azure, Sweden Central", 16, 400, "#3E5060"))
e.append(text(1228, 264, "latest release (8.1+ for $rankFusion)", 16, 400, "#3E5060"))
e.append(box(1228, 284, 308, 152, fill="#FFFFFF", stroke="#9FD9B7", r=10))
e.append(text(1244, 314, "agent_memory", 18, 700, "#00684A"))
e.append(text(1244, 342, "memories · episodes · decisions", 16, 400, "#3E5060"))
e.append(text(1244, 368, "Vector Search + Atlas Search", 16, 400, "#3E5060"))
e.append(text(1244, 394, "IP access list: the VM only", 16, 400, "#3E5060"))
e.append(text(1244, 420, "managed by Terraform", 16, 400, "#3E5060"))

# OpenMetadata callout
e.append(box(1212, 496, 340, 222, fill="#F4F0FE", stroke="#7147E8", sw=2))
e.append(icon("openmetadata", 1228, 512, 34, 41))
e.append(text(1274, 540, "Governed in OpenMetadata", 19, 700, "#5B33D6"))
for i, line in enumerate(["agents as AI applications", "memories in the Context Center,", "  written by each agent's bot", "lineage agents → memory → brain", "terms agents propose, In Review"]):
    e.append(text(1228, 584 + i * 26, ("· " if not line.startswith("  ") else "  ") + line.strip(), 16, 400, "#3E5060"))

# Presenter / portals
e.append(box(1212, 750, 340, 112, fill="#FFFFFF", stroke="#D5DEE5"))
e.append(text(1228, 782, "You, in the portals", 18, 600))
e.append(text(1228, 808, "ai.azure.com · OpenMetadata UI", 16, 400, "#3E5060"))
e.append(text(1228, 832, "Atlas UI (Data Explorer)", 16, 400, "#3E5060"))

# Arrows and labels
e.append(arrow(300, 500, 758, 500, "#00A35C"))
e.append(text(318, 490, "ingest", 15, 600, "#00684A"))
e.append(arrow(708, 278, 758, 278, "#0078D4"))
e.append(text(706, 300, "MCP", 14, 600, "#0B5CA8", "end"))
e.append(arrow(548, 486, 548, 514, "#8C6CE6"))
e.append(arrow(1142, 400, 1212, 340, "#00A35C", both=True))
e.append(text(1150, 432, "TLS", 14, 600, "#00684A"))

defs = (
    '<defs>'
    '<marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker>'
    '<marker id="ah-s" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker>'
    '</defs>'
)
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="Company brain on Azure: Microsoft Foundry agents, a VM with the brain, agent-memory and OpenMetadata, and a MongoDB Atlas cluster for the agents\' memory">{defs}{"".join(e)}</svg>\n'
OUT.write_text(svg)
print(f"{OUT} {len(svg)} bytes")
