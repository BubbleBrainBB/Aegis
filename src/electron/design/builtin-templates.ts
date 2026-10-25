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
[data-aegis-slide]{display:flex;flex-direction:column;justify-content:center;gap:32px;width:100%;height:100%;padding:120px 140px;background:var(--background);color:var(--text)}
.kicker{font:500 24px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.title{margin:0;font:500 112px/1 var(--font-display);letter-spacing:-.03em;text-wrap:balance}
.h2{margin:0;font:500 72px/1.05 var(--font-display);letter-spacing:-.02em}
.lead{margin:0;max-width:1200px;font:36px/1.45 var(--font-body);color:var(--muted)}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:40px}
.three b{display:block;font:600 96px/1 var(--font-display);color:var(--accent);font-variant-numeric:tabular-nums}
.three span{font:30px/1.4 var(--font-body);color:var(--muted)}
</style>
<main data-aegis-deck style="width:100%;height:100%">
  <section data-aegis-slide data-aegis-notes="Open with the one-line promise; pause before the subtitle."><span class="kicker">Series A · 2026</span><h1 class="title">Planning that keeps up with the team</h1><p class="lead">Northwind turns notes and tickets into one plan everyone can trust.</p></section>
  <section data-aegis-slide data-aegis-notes="Name the pain in the customer's words."><span class="kicker">The problem</span><h2 class="h2">Plans live in twelve places and go stale in a week</h2><p class="lead">Teams rebuild the same roadmap in decks, docs and spreadsheets, and nobody knows which one is true.</p></section>
  <section data-aegis-slide data-aegis-notes="Three numbers, then stop talking."><span class="kicker">Traction</span><div class="three"><div><b>1,284</b><span>paying teams</span></div><div><b>3.1×</b><span>revenue, year over year</span></div><div><b>97%</b><span>net retention</span></div></div></section>
</main>`;

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { id: "landing", name: "Landing page", summary: "A product landing page: navbar, hero with a product shot, logos, three features, footer.", width: 1440, height: 1180, html: landing },
  { id: "dashboard", name: "Dashboard", summary: "An app dashboard: sidebar navigation, header with a range switch, four stats, a chart and a recent list.", width: 1440, height: 900, html: dashboard },
  { id: "mobile", name: "Mobile app screen", summary: "A phone home screen (390 × 844): title, balance card, quick actions, recent list and a tab bar.", width: 390, height: 844, html: mobile },
  { id: "settings", name: "Settings form", summary: "A settings page: tabs, profile fields, a select and textarea, notification toggles, an alert and form actions.", width: 1200, height: 1100, html: settings },
  { id: "deck", name: "Pitch deck", summary: "A 1920 × 1080 deck: title, problem and traction slides with speaker notes.", width: 1920, height: 1080, html: deck },
];
