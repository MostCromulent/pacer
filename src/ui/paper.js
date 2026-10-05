// Paper for the finish: streamers and confetti that burst, flutter and fall.
// The scene throws some from the finish banner; rainPaper drops more down the
// whole window.

import { P } from './palette.js';

const COLOURS = [P.coral, P.mustard, P.teal, P.lavender, P.mint, '#F7A1B0'];
const RAIN_S = 1.5; // how long paper is let go for
const RAIN_EVERY_PX = 4; // one piece for about every this much of the window's width

/** One piece of paper at (x, y), moving at (vx, vy) px/s: a curling streamer, or a scrap of confetti. */
export function paperPiece(x, y, vx, vy, { ribbon = false, big = false } = {}) {
  return {
    x, y, vx, vy, ribbon,
    colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
    size: (ribbon ? 22 + Math.random() * 26 : 4 + Math.random() * 3) * (big ? 1.8 : 1),
    width: big ? 4 : 2.6,
    turn: Math.random() * 6,
    spin: (Math.random() - 0.5) * 8,
    sway: Math.random() * 6,
  };
}

/** Draw a piece. `now` is a running time in seconds, which makes it ripple and tumble. */
export function drawPaper(ctx, p, now) {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.ribbon) {
    // A streamer trails behind the way it is going, curling more towards its tail.
    ctx.rotate(Math.atan2(p.vy, p.vx) + Math.PI);
    ctx.strokeStyle = p.colour;
    ctx.lineWidth = p.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const u = i / 14;
      const y = Math.sin(u * 9 + now * 7 + p.sway) * p.size * 0.14 * (0.3 + u);
      if (i) ctx.lineTo(u * p.size, y);
      else ctx.moveTo(0, y);
    }
    ctx.stroke();
  } else {
    ctx.rotate(p.turn);
    ctx.scale(1, Math.cos(now * 6 + p.sway)); // tumbling end over end
    ctx.fillStyle = p.colour;
    ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size / 1.5);
  }
  ctx.restore();
}

/** Move every piece on by `dt` seconds, and return the ones still above `floor`. */
export function dropPaper(pieces, dt, now, { gravity, drag, floor }) {
  for (const p of pieces) {
    p.vy += gravity * dt;
    p.vx *= 1 - drag * dt;
    p.vy *= 1 - drag * dt;
    p.x += (p.vx + Math.sin(now * 3 + p.sway) * 26) * dt;
    p.y += p.vy * dt;
    p.turn += p.spin * dt;
  }
  return pieces.filter((p) => p.y < floor);
}

/** Whether the viewer has asked for less motion. */
export function prefersStill(win = window) {
  return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Let paper go along the top of a window (the page, or the mini window) and
 * flutter down over everything in it. It clears itself away when the last
 * piece has fallen.
 */
export function rainPaper(win = window) {
  if (prefersStill(win)) return;
  const doc = win.document;
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50';
  doc.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let pieces = [];
  let released = 0;
  let began = null;
  let last = 0;
  const frame = (ms) => {
    if (!canvas.isConnected) return; // the window was closed
    began ??= ms;
    const dt = Math.min(0.05, (ms - (last || ms)) / 1000);
    last = ms;
    const since = (ms - began) / 1000;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const wanted = Math.min(1, since / RAIN_S) * Math.min(190, w / RAIN_EVERY_PX);
    for (; released < wanted; released++) {
      pieces.push(paperPiece(Math.random() * w, -20 - Math.random() * 60, (Math.random() - 0.5) * 60, 60 + Math.random() * 120, { ribbon: released % 4 === 0, big: true }));
    }
    pieces = dropPaper(pieces, dt, ms / 1000, { gravity: 60, drag: 0.5, floor: h + 40 });
    for (const p of pieces) drawPaper(ctx, p, ms / 1000);
    if (since < RAIN_S || pieces.length) win.requestAnimationFrame(frame);
    else canvas.remove();
  };
  win.requestAnimationFrame(frame);
}
