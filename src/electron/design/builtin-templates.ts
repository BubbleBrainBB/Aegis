/**
 * Reference pages for the built-in styles: written only against the pack's
 * tokens, classes and components, so each style renders them in its own
 * look. design_resources hands one to the agent to build from (structure,
 * sizes, components), with the task's real content in place of the samples.
 */
export interface BuiltinTemplate {
  id: string;
  name: string;
  summary: string;
  /** When to start from it. */
  use: string;
  /** What it holds before it needs restructuring. */
  capacity: string;
  width: number;
  height: number;
  html: string;
}

const landing = `<style>
.page{min-height:100%;display:flex;flex-direction:column}
.hero{display:grid;grid-template-columns:1.1fr 1fr;gap:64px;align-items:center;padding:96px 96px 80px}
.eyebrow{font:500 12px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.hero h1{margin:20px 0 0;font:500 68px/1.02 var(--font-display);letter-spacing:-.025em;text-wrap:balance}
.lede{margin:24px 0 0;max-width:520px;font:18px/1.6 var(--font-body);color:var(--muted)}
.cta{display:flex;gap:12px;margin-top:36px}
.shot{aspect-ratio:4/3;border-radius:var(--radius);border:1px solid var(--line);background:linear-gradient(160deg, color-mix(in oklch, var(--accent) 14%, var(--surface)), var(--surface));box-shadow:var(--shadow);padding:28px;display:flex;flex-direction:column;gap:14px}
.shot .ds-card{gap:14px}
.logos{display:flex;justify-content:space-between;align-items:center;padding:28px 96px;border-block:1px solid var(--line);font:600 15px/1 var(--font-display);color:var(--muted)}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:96px}
.feature{display:flex;flex-direction:column;gap:12px}
.feature .mark{display:grid;place-items:center;width:44px;height:44px;border-radius:var(--radius-control);background:color-mix(in oklch, var(--accent) 14%, transparent);color:var(--accent)}
.feature h3{margin:6px 0 0;font:600 20px/1.3 var(--font-display)}
.feature p{margin:0;font:15px/1.6 var(--font-body);color:var(--muted)}
.footer{margin-top:auto;display:flex;justify-content:space-between;padding:32px 96px;border-top:1px solid var(--line);font:13px/1 var(--font-body);color:var(--muted)}
</style>
<div class="page">
  <aegis-use component="Navbar" brand="Northwind" links="Product, Customers, Pricing, Docs"><aegis-use component="Button" label="Sign in" variant="ghost" size="sm"></aegis-use><aegis-use component="Button" label="Start free" size="sm"></aegis-use></aegis-use>
  <section class="hero">
    <div>
      <span class="eyebrow">New · Planning 2.0</span>
      <h1>Plan the quarter in an afternoon</h1>
      <p class="lede">Northwind turns scattered notes and tickets into one plan your whole team can read, change and ship.</p>
      <div class="cta"><aegis-use component="Button" label="Start free" size="lg"></aegis-use><aegis-use component="Button" label="Book a demo" variant="secondary" size="lg"><aegis-icon name="calendar" size="18"></aegis-icon></aegis-use></div>
    </div>
    <div class="shot">
      <aegis-use component="Card" title="Q3 roadmap" subtitle="12 projects · 4 teams">
        <aegis-use component="Progress" label="On track" value="72"></aegis-use>
        <aegis-use component="ListItem" title="Self-serve onboarding" subtitle="Growth" meta="Jul 18"><aegis-use component="Avatar" name="Maya Chen" size="sm"></aegis-use></aegis-use>
        <aegis-use component="ListItem" title="Usage-based billing" subtitle="Platform" meta="Aug 2"><aegis-use component="Avatar" name="Omar Ali" size="sm"></aegis-use></aegis-use>
      </aegis-use>
    </div>
  </section>
  <div class="logos"><span>Acme</span><span>Globex</span><span>Initech</span><span>Umbrella</span><span>Hooli</span></div>
  <section class="features">
    <div class="feature"><span class="mark"><aegis-icon name="layout-kanban" size="22"></aegis-icon></span><h3>One plan, every team</h3><p>Roadmaps, owners and dates in one place, synced with the tools your teams already use.</p></div>
    <div class="feature"><span class="mark"><aegis-icon name="bolt" size="22"></aegis-icon></span><h3>Changes in seconds</h3><p>Drag a project and every dependent date moves with it. No spreadsheet surgery.</p></div>
    <div class="feature"><span class="mark"><aegis-icon name="message-circle" size="22"></aegis-icon></span><h3>Decisions on the record</h3><p>Every change carries who, when and why, so the plan explains itself.</p></div>
  </section>
  <footer class="footer"><span>© 2026 Northwind</span><span>Privacy · Terms · Status</span></footer>
</div>`;

const dashboard = `<style>
.app{display:grid;grid-template-columns:232px 1fr;height:100%}
.side{display:flex;flex-direction:column;gap:4px;padding:20px 14px;border-right:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 18px;font:600 16px/1 var(--font-display)}
.nav{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:var(--radius-control);font:500 14px/1 var(--font-body);color:var(--muted)}
.nav.is-active{background:color-mix(in oklch, var(--accent) 12%, transparent);color:var(--text)}
.main{display:flex;flex-direction:column;gap:24px;padding:28px 32px;min-height:0}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.head h1{margin:0;font:600 26px/1.2 var(--font-display);letter-spacing:-.01em}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.grid{flex:1;display:grid;grid-template-columns:1.6fr 1fr;gap:16px;min-height:0}
.chart{flex:1;display:flex;align-items:flex-end;gap:10px;min-height:200px;padding-top:12px}
.chart span{flex:1;border-radius:6px 6px 0 0;background:color-mix(in oklch, var(--accent) 28%, transparent)}
.chart span.is-now{background:var(--accent)}
.axis{display:flex;justify-content:space-between;font:12px/1 var(--font-mono);color:var(--muted)}
</style>
<div class="app">
  <aside class="side">
    <div class="brand"><aegis-icon name="hexagon-letter-n" size="22"></aegis-icon>Northwind</div>
    <a class="nav is-active"><aegis-icon name="layout-dashboard" size="18"></aegis-icon>Overview</a>
    <a class="nav"><aegis-icon name="users" size="18"></aegis-icon>Customers</a>
    <a class="nav"><aegis-icon name="receipt" size="18"></aegis-icon>Invoices</a>
    <a class="nav"><aegis-icon name="chart-bar" size="18"></aegis-icon>Reports</a>
    <a class="nav"><aegis-icon name="settings" size="18"></aegis-icon>Settings</a>
  </aside>
  <main class="main">
    <div class="head"><h1>Overview</h1><div style="display:flex;gap:10px;align-items:center"><aegis-use component="Segmented" options="7D, 30D, 90D" active="1"></aegis-use><aegis-use component="Button" label="Export" variant="secondary" size="sm"><aegis-icon name="download" size="16"></aegis-icon></aegis-use></div></div>
    <div class="stats">
      <aegis-use component="Card"><aegis-use component="Stat" label="Revenue" value="$48,210" delta="+12.4%" trend="up"></aegis-use></aegis-use>
      <aegis-use component="Card"><aegis-use component="Stat" label="Active customers" value="1,284" delta="+3.1%" trend="up"></aegis-use></aegis-use>
      <aegis-use component="Card"><aegis-use component="Stat" label="Churn" value="2.4%" delta="+0.3 pt" trend="down"></aegis-use></aegis-use>
      <aegis-use component="Card"><aegis-use component="Stat" label="Open invoices" value="37" delta="No change" trend="flat"></aegis-use></aegis-use>
    </div>
    <div class="grid">
      <aegis-use component="Card" title="Revenue by week" subtitle="Last 12 weeks">
        <div class="chart"><span style="height:38%"></span><span style="height:46%"></span><span style="height:41%"></span><span style="height:55%"></span><span style="height:52%"></span><span style="height:61%"></span><span style="height:58%"></span><span style="height:67%"></span><span style="height:64%"></span><span style="height:73%"></span><span style="height:79%"></span><span class="is-now" style="height:88%"></span></div>
        <div class="axis"><span>May 5</span><span>Jun 2</span><span>Jun 30</span><span>Jul 21</span></div>
      </aegis-use>
      <aegis-use component="Card" title="Recent customers">
        <aegis-use component="ListItem" title="Acme Corp" subtitle="Enterprise" meta="$12,400"><aegis-use component="Avatar" name="Acme Corp" size="sm"></aegis-use></aegis-use>
        <aegis-use component="ListItem" title="Globex" subtitle="Team" meta="$3,900"><aegis-use component="Avatar" name="Globex" size="sm"></aegis-use></aegis-use>
        <aegis-use component="ListItem" title="Initech" subtitle="Team" meta="$2,150"><aegis-use component="Avatar" name="Initech" size="sm"></aegis-use></aegis-use>
        <aegis-use component="ListItem" title="Hooli" subtitle="Starter" meta="$640"><aegis-use component="Avatar" name="Hooli" size="sm"></aegis-use></aegis-use>
      </aegis-use>
    </div>
  </main>
</div>`;

const mobile = `<style>
.screen{display:flex;flex-direction:column;height:100%;padding:16px 20px 0;gap:20px}
.top{display:flex;align-items:center;justify-content:space-between;padding-top:44px}
.top h1{margin:0;font:600 30px/1.1 var(--font-display);letter-spacing:-.015em}
.balance{display:flex;flex-direction:column;gap:6px;padding:22px;border-radius:var(--radius);background:var(--accent);color:var(--on-accent)}
.balance small{font:500 13px/1 var(--font-body);opacity:.8}
.balance strong{font:600 38px/1.1 var(--font-display);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.actions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center;font:500 12px/1.2 var(--font-body);color:var(--muted)}
.actions span{display:flex;flex-direction:column;align-items:center;gap:8px}
.actions i{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--surface);border:1px solid var(--line);color:var(--text)}
.section{font:600 15px/1 var(--font-body)}
.tabbar{margin-top:auto;display:grid;grid-template-columns:repeat(4,1fr);padding:10px 8px 30px;border-top:1px solid var(--line);background:var(--surface);margin-inline:-20px;font:500 11px/1 var(--font-body);color:var(--muted);text-align:center}
.tabbar span{display:flex;flex-direction:column;align-items:center;gap:6px}
.tabbar .is-active{color:var(--accent)}
</style>
<div class="screen">
  <div class="top"><h1>Wallet</h1><aegis-use component="Avatar" name="Maya Chen" size="md"></aegis-use></div>
  <div class="balance"><small>Available balance</small><strong>$4,826.10</strong></div>
  <div class="actions">
    <span><i><aegis-icon name="arrow-up-right" size="20"></aegis-icon></i>Send</span>
    <span><i><aegis-icon name="arrow-down-left" size="20"></aegis-icon></i>Request</span>
    <span><i><aegis-icon name="plus" size="20"></aegis-icon></i>Top up</span>
    <span><i><aegis-icon name="dots" size="20"></aegis-icon></i>More</span>
  </div>
  <div class="section">Recent</div>
  <div>
    <aegis-use component="ListItem" title="Blue Bottle Coffee" subtitle="Today, 8:12" meta="−$6.50"><aegis-use component="Avatar" name="Blue Bottle" size="md"></aegis-use></aegis-use>
    <aegis-use component="ListItem" title="Omar Ali" subtitle="Dinner split" meta="+$42.00"><aegis-use component="Avatar" name="Omar Ali" size="md"></aegis-use></aegis-use>
    <aegis-use component="ListItem" title="City Transit" subtitle="Yesterday" meta="−$2.75"><aegis-use component="Avatar" name="City Transit" size="md"></aegis-use></aegis-use>
  </div>
  <nav class="tabbar">
    <span class="is-active"><aegis-icon name="home" size="22"></aegis-icon>Home</span>
    <span><aegis-icon name="chart-pie" size="22"></aegis-icon>Spending</span>
    <span><aegis-icon name="credit-card" size="22"></aegis-icon>Cards</span>
    <span><aegis-icon name="user" size="22"></aegis-icon>Profile</span>
  </nav>
</div>`;

const settings = `<style>
.wrap{max-width:760px;margin:0 auto;padding:48px 32px;display:flex;flex-direction:column;gap:28px}
.wrap h1{margin:0;font:600 30px/1.2 var(--font-display);letter-spacing:-.01em}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.group{display:flex;flex-direction:column;gap:16px}
.end{display:flex;justify-content:flex-end;gap:10px}
</style>
<div class="wrap">
  <h1>Settings</h1>
  <aegis-use component="Tabs" tabs="Profile, Notifications, Billing, Security">
    <div class="group">
      <aegis-use component="Card" title="Profile" subtitle="How others see you across the workspace.">
        <div style="display:flex;align-items:center;gap:16px"><aegis-use component="Avatar" name="Maya Chen" size="lg"></aegis-use><aegis-use component="Button" label="Change photo" variant="secondary" size="sm"></aegis-use></div>
        <div class="row"><aegis-use component="Field" label="Full name" value="Maya Chen"></aegis-use><aegis-use component="Field" label="Email" type="email" value="maya@northwind.co"></aegis-use></div>
        <aegis-use component="Select" label="Time zone" options="Pacific (UTC−7), Eastern (UTC−4), London (UTC+1)" value="Pacific (UTC−7)"></aegis-use>
        <aegis-use component="Field" label="Bio" multiline="true" placeholder="A sentence or two about you"></aegis-use>
      </aegis-use>
      <aegis-use component="Card" title="Notifications">
        <aegis-use component="Toggle" label="Weekly summary email" checked="true"></aegis-use>
        <aegis-use component="Toggle" label="Mentions and replies" checked="true"></aegis-use>
        <aegis-use component="Toggle" label="Product updates" checked="false"></aegis-use>
      </aegis-use>
      <aegis-use component="Alert" tone="warning" title="Your plan renews in 3 days">Update the card on file to avoid an interruption.</aegis-use>
      <div class="end"><aegis-use component="Button" label="Cancel" variant="ghost"></aegis-use><aegis-use component="Button" label="Save changes"></aegis-use></div>
    </div>
  </aegis-use>
</div>`;

const deck = `<style>
[data-aegis-slide]{display:flex;flex-direction:column;justify-content:center;gap:32px;width:100%;height:100%;padding:120px 140px;background:var(--background);color:var(--text);position:relative}
.kicker{font:500 24px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.title{margin:0;font:500 112px/1 var(--font-display);letter-spacing:-.03em;text-wrap:balance;max-width:1500px}
.h2{margin:0;font:500 72px/1.05 var(--font-display);letter-spacing:-.02em;text-wrap:balance;max-width:1500px}
.lead{margin:0;max-width:1200px;font:36px/1.45 var(--font-body);color:var(--muted)}
.foot{position:absolute;left:140px;right:140px;bottom:64px;display:flex;justify-content:space-between;font:24px/1 var(--font-mono);color:var(--muted)}
.section{background:var(--accent);color:var(--on-accent)}
.section .kicker,.section .lead{color:inherit;opacity:.8}
.big{display:block;font:600 280px/1.15 var(--font-display);letter-spacing:-.04em;color:var(--accent);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:48px}
.col{display:flex;flex-direction:column;gap:20px;padding:48px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--line)}
.col h3{margin:0;font:600 40px/1.2 var(--font-display)}
.col ul{margin:0;padding-left:1.1em;font:30px/1.5 var(--font-body);color:var(--muted)}
.col.is-ours{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}
.quote{margin:0;font:400 76px/1.15 var(--font-display);letter-spacing:-.015em;text-wrap:balance;max-width:1500px}
.who{display:flex;align-items:center;gap:24px;font:30px/1.3 var(--font-body);color:var(--muted)}
.who .ds-avatar{width:88px;height:88px;font-size:32px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:96px;align-items:center}
.visual{aspect-ratio:4/3;border-radius:var(--radius);background:linear-gradient(150deg, color-mix(in oklch, var(--accent) 35%, var(--surface)), color-mix(in oklch, var(--accent) 8%, var(--background)));display:grid;place-items:center;color:var(--accent)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:32px;border-top:3px solid var(--line);padding-top:40px}
.steps b{display:block;font:500 28px/1 var(--font-mono);color:var(--accent);margin-bottom:16px}
.steps span{font:32px/1.35 var(--font-body);color:var(--muted)}
.steps .is-now span{color:var(--text)}
</style>
<main data-aegis-deck style="width:100%;height:100%">
  <section data-aegis-slide data-aegis-notes="Cover: the one-line promise. Pause before the subtitle."><span class="kicker">Series A · 2026</span><h1 class="title">Planning that keeps up with the team</h1><p class="lead">Northwind turns notes and tickets into one plan everyone can trust.</p><div class="foot"><span>Northwind</span><span>Confidential</span></div></section>
  <section data-aegis-slide class="section" data-aegis-notes="Section divider: name the chapter, nothing else."><span class="kicker">02</span><h2 class="h2">The problem</h2></section>
  <section data-aegis-slide data-aegis-notes="Big number: say it, then stop talking."><span class="big">3.1×</span><p class="lead">Revenue growth year over year, with the same sales team.</p></section>
  <section data-aegis-slide data-aegis-notes="Comparison: two columns, ours highlighted."><h2 class="h2">Why teams switch</h2><div class="cols"><div class="col"><h3>Spreadsheets and decks</h3><ul><li>Twelve copies of the plan</li><li>Stale within a week</li><li>Nobody knows who changed what</li></ul></div><div class="col is-ours"><h3>Northwind</h3><ul><li>One plan, always current</li><li>Dates move with dependencies</li><li>Every change on the record</li></ul></div></div></section>
  <section data-aegis-slide data-aegis-notes="Quote: a customer in their own words."><p class="quote">“We stopped arguing about which roadmap was real. There is only one now.”</p><div class="who"><aegis-use component="Avatar" name="Maya Chen" size="lg"></aegis-use><span>Maya Chen, VP Product at Acme</span></div></section>
  <section data-aegis-slide data-aegis-notes="Image and text: the product doing the thing."><div class="split"><div style="display:flex;flex-direction:column;gap:32px"><span class="kicker">Product</span><h2 class="h2">Drag a project, the plan follows</h2><p class="lead">Dependent dates, owners and capacity update as you move things.</p></div><div class="visual"><aegis-icon name="layout-kanban" size="160" stroke-width="1"></aegis-icon></div></div></section>
  <section data-aegis-slide data-aegis-notes="Timeline: where we are and what comes next."><h2 class="h2">Roadmap</h2><div class="steps"><div><b>Q1</b><span>Self-serve onboarding</span></div><div class="is-now"><b>Q2 · now</b><span>Usage-based billing</span></div><div><b>Q3</b><span>Portfolio views</span></div><div><b>Q4</b><span>Enterprise controls</span></div></div></section>
  <section data-aegis-slide class="section" data-aegis-notes="Closing: the ask and how to reach us."><h2 class="h2">Raising $12M to bring one plan to every team</h2><p class="lead">maya@northwind.co · northwind.co</p></section>
</main>`;

const components = `<style>
.sheet{display:flex;flex-direction:column;gap:40px;padding:56px 64px}
.sheet h1{margin:0;font:600 34px/1.2 var(--font-display);letter-spacing:-.01em}
.sheet h2{margin:0 0 16px;font:500 12px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;align-items:start}
.swatches{display:flex;flex-wrap:wrap;gap:12px}
.swatch{display:flex;flex-direction:column;gap:8px;font:12px/1.2 var(--font-mono);color:var(--muted)}
.swatch i{width:72px;height:48px;border-radius:min(var(--radius), 10px);border:1px solid var(--line)}
.type{display:flex;flex-direction:column;gap:10px}
</style>
<div class="sheet">
  <h1>Components</h1>
  <section><h2>Color</h2><div class="swatches">
    <span class="swatch"><i style="background:var(--background)"></i>background</span><span class="swatch"><i style="background:var(--surface)"></i>surface</span><span class="swatch"><i style="background:var(--text)"></i>text</span><span class="swatch"><i style="background:var(--muted)"></i>muted</span><span class="swatch"><i style="background:var(--line)"></i>line</span><span class="swatch"><i style="background:var(--accent)"></i>accent</span><span class="swatch"><i style="background:var(--success)"></i>success</span><span class="swatch"><i style="background:var(--warning)"></i>warning</span><span class="swatch"><i style="background:var(--danger)"></i>danger</span>
  </div></section>
  <section><h2>Type</h2><div class="type"><span style="font:500 48px/1.05 var(--font-display);letter-spacing:-.02em">Display heading</span><span style="font:600 22px/1.3 var(--font-display)">Section title</span><span style="font:16px/1.6 var(--font-body);max-width:640px">Body text sets the reading rhythm: about sixty-five characters per line, generous line height.</span><span style="font:500 12px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Mono label · 1,284</span></div></section>
  <section><h2>Buttons</h2><div class="row">
    <aegis-use component="Button" label="Primary"></aegis-use><aegis-use component="Button" label="Secondary" variant="secondary"></aegis-use><aegis-use component="Button" label="Ghost" variant="ghost"></aegis-use><aegis-use component="Button" label="Delete" variant="danger"></aegis-use><aegis-use component="Button" label="Disabled" disabled="true"></aegis-use><aegis-use component="Button" label="Search" variant="secondary" size="sm"><aegis-icon name="search" size="16"></aegis-icon></aegis-use><aegis-use component="IconButton" label="More" variant="secondary"><aegis-icon name="dots" size="18"></aegis-icon></aegis-use>
  </div></section>
  <section><h2>Selection</h2><div class="row"><aegis-use component="Toggle" label="On" checked="true"></aegis-use><aegis-use component="Toggle" label="Off" checked="false"></aegis-use><aegis-use component="Checkbox" label="Checked" checked="true"></aegis-use><aegis-use component="Checkbox" label="Unchecked"></aegis-use><aegis-use component="Segmented" options="Day, Week, Month" active="1"></aegis-use></div></section>
  <section><h2>Tags and people</h2><div class="row"><aegis-use component="Tag" label="Neutral"></aegis-use><aegis-use component="Tag" label="Accent" tone="accent"></aegis-use><aegis-use component="Tag" label="Paid" tone="success"></aegis-use><aegis-use component="Tag" label="Due soon" tone="warning"></aegis-use><aegis-use component="Tag" label="Overdue" tone="danger"></aegis-use><aegis-use component="Avatar" name="Maya Chen" size="sm"></aegis-use><aegis-use component="Avatar" name="Omar Ali"></aegis-use><aegis-use component="Avatar" name="Ada Lovelace" size="lg"></aegis-use></div></section>
  <section><h2>Forms</h2><div class="grid"><aegis-use component="Field" label="Email" placeholder="you@company.com" hint="We never share it."></aegis-use><aegis-use component="Field" label="Workspace" value="acme" error="That workspace name is taken."></aegis-use><aegis-use component="Select" label="Plan" options="Starter, Team, Enterprise" value="Team"></aegis-use></div></section>
  <section><h2>Data and feedback</h2><div class="grid">
    <aegis-use component="Card"><aegis-use component="Stat" label="Revenue" value="$48,210" delta="+12.4%" trend="up"></aegis-use></aegis-use>
    <aegis-use component="Card"><aegis-use component="Progress" label="Storage" value="64"></aegis-use></aegis-use>
    <aegis-use component="Card" title="Recent"><aegis-use component="ListItem" title="Acme Corp" subtitle="Enterprise" meta="$12,400" interactive="true"><aegis-use component="Avatar" name="Acme Corp" size="sm"></aegis-use></aegis-use></aegis-use>
  </div><div class="grid" style="margin-top:24px"><aegis-use component="Alert" tone="info" title="Heads up">Sync runs every hour.</aegis-use><aegis-use component="Alert" tone="success" title="Saved">Your changes are live.</aegis-use><aegis-use component="Alert" tone="danger" title="Payment failed">Update the card on file.</aegis-use></div></section>
  <section><h2>Navigation</h2><aegis-use component="Navbar" brand="Northwind" links="Product, Pricing, Docs"><aegis-use component="Button" label="Sign in" size="sm"></aegis-use></aegis-use><div style="margin-top:24px"><aegis-use component="Tabs" tabs="Overview, Activity, Settings"><p style="margin:0;color:var(--muted)">Panel content</p></aegis-use></div></section>
</div>`;

const examples = `<style>
.ex{display:flex;flex-direction:column;gap:48px;padding:56px 64px}
.ex h1{margin:0;font:600 34px/1.2 var(--font-display)}
.pair{display:grid;grid-template-columns:1fr 1fr 300px;gap:24px;align-items:stretch}
.pane{display:flex;flex-direction:column;gap:12px}
.pane>span{font:500 12px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase}
.pane.weak>span{color:var(--danger)}
.pane.strong>span{color:var(--success)}
.box{flex:1;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:28px}
.why{margin:0;font:14px/1.6 var(--font-body);color:var(--muted);align-self:center}
.why b{display:block;color:var(--text);font-size:15px;margin-bottom:6px}
</style>
<div class="ex">
  <h1>Weak and strong, side by side</h1>
  <div class="pair">
    <div class="pane weak"><span>Weak</span><div class="box" style="display:flex;flex-direction:column;gap:12px;text-align:center"><b style="font:700 22px var(--font-body)">PRO PLAN</b><b style="font:700 22px var(--font-body)">$24 / MONTH</b><b style="font:700 18px var(--font-body)">Unlimited projects</b><b style="font:700 18px var(--font-body)">Priority support</b><aegis-use component="Button" label="Buy now"></aegis-use></div></div>
    <div class="pane strong"><span>Strong</span><div class="box" style="display:flex;flex-direction:column;gap:20px"><div style="display:flex;justify-content:space-between;align-items:center"><span style="font:600 17px var(--font-display)">Pro</span><aegis-use component="Tag" label="Most teams" tone="accent"></aegis-use></div><div><span style="font:600 44px/1 var(--font-display);font-variant-numeric:tabular-nums">$24</span><span style="color:var(--muted)"> per seat / month</span></div><div style="display:flex;flex-direction:column;gap:8px;font:15px/1.4 var(--font-body);color:var(--muted)"><span>Unlimited projects</span><span>Priority support within 4 hours</span></div><aegis-use component="Button" label="Start 14-day trial"></aegis-use></div></div>
    <p class="why"><b>Hierarchy</b>When everything is bold and centered nothing leads. One large figure, quiet supporting text, left alignment, and a button that says what happens.</p>
  </div>
  <div class="pair">
    <div class="pane weak"><span>Weak</span><div class="box" style="display:flex;flex-direction:column;gap:16px"><aegis-use component="Field" label="First name"></aegis-use><aegis-use component="Field" label="Last name"></aegis-use><aegis-use component="Field" label="Card number"></aegis-use><aegis-use component="Field" label="Expiry"></aegis-use></div></div>
    <div class="pane strong"><span>Strong</span><div class="box" style="display:flex;flex-direction:column;gap:32px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><aegis-use component="Field" label="First name"></aegis-use><aegis-use component="Field" label="Last name"></aegis-use></div><div style="display:grid;grid-template-columns:2fr 1fr;gap:12px"><aegis-use component="Field" label="Card number"></aegis-use><aegis-use component="Field" label="Expiry" placeholder="MM / YY"></aegis-use></div></div></div>
    <p class="why"><b>Spacing groups</b>Equal gaps everywhere hide the structure. Tight gaps inside a group, wide gaps between groups, and widths that match the expected input.</p>
  </div>
  <div class="pair">
    <div class="pane weak"><span>Weak</span><div class="box" style="display:flex;flex-direction:column;gap:12px"><div style="padding:14px;border-radius:var(--radius-control);background:var(--accent);color:var(--on-accent)">Invoices <b>37</b></div><div style="padding:14px;border-radius:var(--radius-control);background:var(--accent);color:var(--on-accent)">Overdue <b>4</b></div><div style="padding:14px;border-radius:var(--radius-control);background:var(--accent);color:var(--on-accent)">Paid <b>33</b></div></div></div>
    <div class="pane strong"><span>Strong</span><div class="box" style="display:flex;flex-direction:column;gap:4px"><aegis-use component="ListItem" title="Invoices" meta="37"></aegis-use><aegis-use component="ListItem" title="Overdue" meta="4"><aegis-use component="Tag" label="Needs action" tone="danger"></aegis-use></aegis-use><aegis-use component="ListItem" title="Paid" meta="33"></aegis-use></div></div>
    <p class="why"><b>Color with intent</b>The accent on every row means nothing. Neutral rows, and color only where something needs attention, so the eye lands on it.</p>
  </div>
</div>`;

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: "landing", name: "Landing page", summary: "A product landing page: navbar, hero with a product shot, logos, three features, footer.",
    use: "Marketing pages, product launches, waitlists: anything that sells one product or idea.",
    capacity: "One headline (up to ~8 words), a two-line lede, two calls to action, 3–6 features; add sections (pricing, testimonials, FAQ) below in the same rhythm.",
    width: 1440, height: 1180, html: landing,
  },
  {
    id: "dashboard", name: "Dashboard", summary: "An app dashboard: sidebar navigation, header with a range switch, four stats, a chart and a recent list.",
    use: "Admin and analytics screens, overviews, back-office home pages.",
    capacity: "5–8 nav items, 3–4 key figures, one main chart and one list or table; split into tabs before adding a second chart row.",
    width: 1440, height: 900, html: dashboard,
  },
  {
    id: "mobile", name: "Mobile app screen", summary: "A phone home screen (390 × 844): title, balance card, quick actions, recent list and a tab bar.",
    use: "Phone app home and list screens; frame it with design_starter ios-phone when it should read as a device.",
    capacity: "One hero figure or card, up to 4 quick actions, 3–6 list rows above the fold, 3–5 tabs.",
    width: 390, height: 844, html: mobile,
  },
  {
    id: "settings", name: "Settings form", summary: "A settings page: tabs, profile fields, a select and textarea, notification toggles, an alert and form actions.",
    use: "Settings, account, onboarding and any form-heavy page.",
    capacity: "Up to ~8 fields per card and 3–4 cards per tab; longer forms become steps.",
    width: 1200, height: 1100, html: settings,
  },
  {
    id: "deck", name: "Slide layouts", summary: "A 1920 × 1080 palette of slide layouts: cover, section, big number, comparison, quote, image and text, timeline, closing.",
    use: "Any deck: copy only the layouts the content needs into an empty deck, in the content's order.",
    capacity: "One idea per slide: a title up to ~10 words and at most 3 short points or one figure.",
    width: 1920, height: 1080, html: deck,
  },
  {
    id: "components", name: "Component sheet", summary: "Every built-in component and the style's colors and type on one board, with their main variants and states.",
    use: "To see what the style offers before designing, or as a style sheet board the user can review.",
    capacity: "Reference only; not a page to ship.",
    width: 1200, height: 1600, html: components,
  },
  {
    id: "examples", name: "Weak and strong examples", summary: "Side-by-side weak and strong versions of a pricing card, a form and a list, each with the reason.",
    use: "When unsure what makes a block better: hierarchy, spacing groups, color with intent.",
    capacity: "Reference only; not a page to ship.",
    width: 1200, height: 1280, html: examples,
  },
];
