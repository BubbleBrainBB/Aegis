---
name: mobile-prototype
title: Mobile prototype
description: A phone app prototype, ready to open and pin on a phone
---
The user is building a phone app prototype they may open on their phone and add to the home screen. Make it ready for that by default; don't ask first.

## Head tags
Always include:
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Short title">
<link rel="apple-touch-icon" href="icon.svg">
<link rel="icon" href="icon.svg">
```

## App icon
Make an `icon.svg` in the project (a 512×512 square, filled to the edges; the phone rounds the corners itself). A simple, bold mark that reads at small sizes: one glyph or monogram on a solid or two-tone ground. No photos, tiny type or washy gradients that blur at 60×60. Without a brand, pick one deliberate accent color and use it in both the icon and the app.

## Layout
On a phone-width viewport the app fills the screen edge to edge, honoring the safe areas with `env(safe-area-inset-*)`: no page chrome, no max-width container. The status bar area should look intentional (the app's background, or a color that tucks under the notch).

On a wide viewport (at least 700px), center the app in a phone-sized rectangle (about 390×844, corners about 44px) on a soft background, so the designer sees it as a phone on the desktop:
```css
html,body{margin:0;height:100%;overscroll-behavior:none}
body{background:#111;display:grid;place-items:center}
#app{width:100vw;height:100vh;background:var(--app-bg);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
@media (min-width:700px){#app{width:390px;height:844px;border-radius:44px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.35)}}
```

## No fake system chrome
Don't paint a fake status bar ("9:41 · battery · wifi") or a fake keyboard in an installable prototype: on a real phone the system draws its own on top, and a painted copy looks doubled. Let the safe-area insets reserve the room. This holds inside the desktop phone rectangle too.

When the user instead wants screens presented as device mockups (a flow laid out on a canvas, a pitch, a comparison), use the `ios_frame.jsx` or `android_frame.jsx` starter, which draws an accurate device with its status bar, and put each screen inside it.

## Behavior
Wrap the app in `<div id="app">`. Navigation, state, transitions and forms all work, so it feels like a real app. Touch targets at least 44px, body text at least 16px, primary actions within thumb reach near the bottom.
