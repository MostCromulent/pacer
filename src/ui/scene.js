// The papercraft race scene, drawn on a canvas every frame.
//
// The road is the workout: x maps to time (PX_PER_S), and each step's slope comes
// from how heavy it is (the caller passes a steepness per step, from the
// resistance target), so the terrain ahead previews the next steps. Your rider
// sits at a fixed x; the ghost is placed by the gap.

import { P, ZONE_COLORS } from './palette.js';
import { pctAt, zoneOf } from '../core/workout.js';

const W = 360;
const PX_PER_S = 4;
const YOU_X = 150;
const SLOPE_K = 1.5;
const GHOST_MIN_X = 24;
const GHOST_MAX_X = 336;

export class Scene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ height?: number }} [opts] scene height in CSS px (width is fixed at 360)
   */
  constructor(canvas, { height = 380 } = {}) {
    this.canvas = canvas;
    this.H = height;
    // Layout is anchored to the bottom so the road and riders keep their size
    // when the scene is shorter; the sky and mountains give up the space.
    this.roadBase = height - Math.max(70, Math.min(88, height * 0.23));
    this.ampScale = Math.min(1, 0.4 + height / 630);
    this.pixelScale = 1;
    this.ctx = canvas.getContext('2d');
    this.dpr = 0;
    this.workout = null;
    this.elev = new Float32Array(1);
    this.camElev = null;
    this.crank = 0;
    this.ghostCrank = 1.3;
    this.wheel = 0;
    this.ghostWheel = 0;
    this.ghostScreenX = null;
    this.stand = 0; // 0 seated .. 1 out of the saddle, eased between the two
  }

  /**
   * @param {object} workout
   * @param {(segment) => number} [steepness] -1 (steep descent) .. 1 (steep climb)
   *   per step. Defaults to one based on the step's power.
   */
  setWorkout(workout, steepness = (seg) => Math.tanh((seg.pct - 70) / 45)) {
    const first = this.workout !== workout;
    this.workout = workout;
    const slopes = workout.segments.map((seg) => SLOPE_K * Math.max(-1, Math.min(1, steepness(seg))));
    const n = workout.totalS;
    const e = new Float32Array(n + 1);
    let si = 0;
    for (let t = 0; t < n; t++) {
      while (si < slopes.length - 1 && t >= workout.segments[si].start + workout.segments[si].dur) si++;
      e[t + 1] = e[t] + slopes[si];
    }
    this.elev = e;
    if (first) {
      this.camElev = null;
      this.ghostScreenX = null;
    }
  }

  elevAt(t) {
    const e = this.elev;
    const last = e.length - 1;
    if (t <= 0) return e[0];
    if (t >= last) return e[last];
    const i = Math.floor(t);
    return e[i] + (e[i + 1] - e[i]) * (t - i);
  }

  roadY(x, t) {
    return this.roadBase - (this.elevAt(t + (x - YOU_X) / PX_PER_S) - this.camElev);
  }

  _fit() {
    const dpr = Math.min(4, ((this.canvas.ownerDocument.defaultView?.devicePixelRatio) || 1) * this.pixelScale);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = W * dpr;
      this.canvas.height = this.H * dpr;
    }
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * @param {object} snap  RideSession.snapshot() (or a preview stand-in)
   * @param {number} dt    seconds since the last frame, for animation
   */
  render(snap, dt) {
    if (!this.workout) return;
    this._fit();
    const ctx = this.ctx;
    const t = snap.t;
    const worldX = t * PX_PER_S;

    // Camera follows your elevation smoothly.
    const target = this.elevAt(t);
    this.camElev = this.camElev === null ? target : this.camElev + (target - this.camElev) * Math.min(1, dt * 3);

    // Animation: cranks turn with cadence, wheels with speed.
    this.crank += ((snap.cadence || 0) / 60) * Math.PI * 2 * dt;
    this.wheel += (snap.speed || 0) / 0.34 * dt;
    const ghostCad = snap.ghostCadence ?? 86;
    this.ghostCrank += (ghostCad / 60) * Math.PI * 2 * dt;
    this.ghostWheel += (snap.ghostSpeed ?? snap.speed ?? 0) / 0.34 * dt;
    // Riders get out of the saddle on standing steps, and settle back after.
    const standing = snap.seg?.position === 'standing' ? 1 : 0;
    this.stand += (standing - this.stand) * Math.min(1, dt * 4);

    ctx.clearRect(0, 0, W, this.H);
    this._sky(ctx, worldX);
    this._mountains(ctx, worldX * 0.12, this.H - 144, 64 * this.ampScale, 70, P.mountain, 11, true);
    this._mountains(ctx, worldX * 0.22, this.H - 126, 44 * this.ampScale, 56, P.mountain2, 29, false);
    this._hills(ctx, worldX * 0.45);
    this._ground(ctx, t);
    this._gates(ctx, t);
    this._finish(ctx, t);

    // Ghost position from the gap, converted to "seconds of riding" at your speed.
    const pace = Math.max(snap.speed || 0, 4);
    const rawX = YOU_X + (-snap.gap / pace) * PX_PER_S;
    const gx = Math.min(GHOST_MAX_X, Math.max(GHOST_MIN_X, rawX));
    this.ghostScreenX = this.ghostScreenX === null ? gx : this.ghostScreenX + (gx - this.ghostScreenX) * Math.min(1, dt * 3);
    const ghostX = this.ghostScreenX;
    const offscreen = rawX < GHOST_MIN_X || rawX > GHOST_MAX_X;

    // The ghost always rides "behind the glass", so it never hides your rider.
    this._rider(ctx, ghostX, t, { ghost: true, crank: this.ghostCrank, wheel: this.ghostWheel });
    this._rider(ctx, YOU_X, t, { ghost: false, crank: this.crank, wheel: this.wheel, speedLines: (snap.speed || 0) > 6 });

    const ghostTag = offscreen ? `${snap.ghostLabel} ${tagGap(-snap.gap)}` : snap.ghostLabel;
    // Lift the ghost's tag when the riders are side by side so the tags don't collide.
    const lift = Math.abs(ghostX - YOU_X) < 50 ? 24 : 0;
    this._tag(ctx, ghostX, this.roadY(ghostX, t) - 76 - lift, ghostTag, P.lavenderText);
    this._tag(ctx, YOU_X, this.roadY(YOU_X, t) - 78 - this.stand * 6, 'YOU', P.coralText);
  }

  _shadow(ctx, on) {
    if (on) {
      ctx.shadowColor = P.shadow;
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 2;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
  }

  _sky(ctx, worldX) {
    ctx.fillStyle = P.sky;
    ctx.fillRect(0, 0, W, this.H);
    const k = this.H / 380;
    ctx.fillStyle = P.skyTop;
    ctx.fillRect(0, 0, W, 80 * k);
    const sunY = 96 * k;
    const sunR = 32 * Math.max(0.8, k);
    this._shadow(ctx, true);
    circle(ctx, 284, sunY, sunR, P.sun);
    this._shadow(ctx, false);
    circle(ctx, 284, sunY, sunR * 0.72, P.sunInner);
    this._shadow(ctx, true);
    const span = W + 160;
    for (const [bx, by, s] of [[70, 70, 1], [230, 122, 0.7], [400, 92, 0.85]]) {
      const x = mod(bx - worldX * 0.05, span) - 80;
      cloud(ctx, x, by * k + (1 - k) * 20, s * Math.max(0.75, k));
    }
    this._shadow(ctx, false);
  }

  _mountains(ctx, offset, base, amp, spacing, color, seed, snowy) {
    const k0 = Math.floor(offset / spacing) - 1;
    const pts = [];
    for (let k = k0; k * spacing - offset < W + spacing; k++) {
      const x = k * spacing - offset;
      const y = base - amp * (0.35 + 0.65 * hash(k + seed));
      pts.push([x, y]);
      pts.push([x + spacing / 2, base - amp * 0.25 * hash(k * 3 + seed)]);
    }
    this._shadow(ctx, true);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], this.H);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], this.H);
    ctx.closePath();
    ctx.fill();
    this._shadow(ctx, false);
    if (snowy) {
      ctx.fillStyle = P.snow;
      for (let i = 0; i < pts.length; i += 2) {
        const [x, y] = pts[i];
        if (y < base - amp * 0.75) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 11, y + 13);
          ctx.lineTo(x - 4, y + 10);
          ctx.lineTo(x, y + 14);
          ctx.lineTo(x + 5, y + 10);
          ctx.lineTo(x + 11, y + 13);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }

  _hills(ctx, offset) {
    const y = (x) => this.H - 118 + 10 * Math.sin((x + offset) / 46) + 6 * Math.sin((x + offset) / 19 + 1.3);
    this._shadow(ctx, true);
    ctx.fillStyle = P.hill;
    ctx.beginPath();
    ctx.moveTo(0, this.H);
    for (let x = 0; x <= W; x += 6) ctx.lineTo(x, y(x));
    ctx.lineTo(W, this.H);
    ctx.closePath();
    ctx.fill();
    // Trees every ~70px of world, some skipped.
    const spacing = 70;
    const k0 = Math.floor(offset / spacing) - 1;
    for (let k = k0; k * spacing - offset < W + spacing; k++) {
      if (hash(k + 101) < 0.35) continue;
      const x = k * spacing - offset + hash(k + 7) * 30;
      const by = y(x) + 4;
      ctx.fillStyle = P.trunk;
      ctx.fillRect(x - 2, by - 14, 4, 14);
      if (hash(k + 55) > 0.5) {
        circle(ctx, x, by - 20, 9 + hash(k) * 3, P.tree);
      } else {
        ctx.fillStyle = P.pine;
        ctx.beginPath();
        ctx.moveTo(x, by - 36);
        ctx.lineTo(x + 9, by - 12);
        ctx.lineTo(x - 9, by - 12);
        ctx.closePath();
        ctx.fill();
      }
    }
    this._shadow(ctx, false);
  }

  _ground(ctx, t) {
    const step = 6;
    // Ground below the road.
    this._shadow(ctx, true);
    ctx.fillStyle = P.ground;
    ctx.beginPath();
    ctx.moveTo(-10, this.H);
    for (let x = -10; x <= W + 10; x += step) ctx.lineTo(x, this.roadY(x, t));
    ctx.lineTo(W + 10, this.H);
    ctx.closePath();
    ctx.fill();

    // Kerbs coloured by the zone of that part of the workout.
    ctx.lineWidth = 25;
    ctx.lineCap = 'butt';
    for (let x = -10; x <= W + 10; x += step) {
      const tx = t + (x - YOU_X) / PX_PER_S;
      const pct = tx < 0 || tx > this.workout.totalS ? 50 : pctAt(this.workout, tx);
      ctx.strokeStyle = ZONE_COLORS[zoneOf(pct)];
      ctx.beginPath();
      ctx.moveTo(x, this.roadY(x, t));
      ctx.lineTo(x + step + 0.5, this.roadY(x + step + 0.5, t));
      ctx.stroke();
    }
    // Road surface.
    ctx.strokeStyle = P.road;
    ctx.lineWidth = 19;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let x = -10; x <= W + 10; x += step) {
      const y = this.roadY(x, t);
      if (x === -10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    this._shadow(ctx, false);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.setLineDash([10, 9]);
    ctx.lineDashOffset = t * PX_PER_S;
    ctx.stroke();
    ctx.setLineDash([]);

    // A few paper flowers on the verge.
    const spacing = 48;
    const off = t * PX_PER_S;
    const k0 = Math.floor(off / spacing) - 1;
    this._shadow(ctx, true);
    for (let k = k0; k * spacing - off < W + spacing; k++) {
      const x = k * spacing - off + hash(k + 3) * 20;
      const y = this.roadY(x, t) + 30 + hash(k + 9) * 34;
      if (y > this.H - 4) continue;
      const pink = hash(k + 21) > 0.7;
      circle(ctx, x, y, 3.4, pink ? '#F7A1B0' : '#FFFFFF');
      if (!pink) circle(ctx, x, y, 1.3, P.mustard);
    }
    this._shadow(ctx, false);
  }

  _gates(ctx, t) {
    for (const g of this.workout.gates) {
      const xs = YOU_X + (g.start - t) * PX_PER_S;
      const xe = YOU_X + (g.end - t) * PX_PER_S;
      if (xe < -30 || xs > W + 40) continue;
      if (xs > -30 && xs < W + 40) this._arch(ctx, xs, t, 'GATE');
      if (xe > -10 && xe < W + 20) this._flag(ctx, xe, t);
    }
  }

  _arch(ctx, x, t, label) {
    const l = x - 15;
    const r = x + 15;
    const yl = this.roadY(l, t);
    const yr = this.roadY(r, t);
    const top = Math.min(yl, yr) - 58;
    this._shadow(ctx, true);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(l - 2, top, 4, yl - top + 2);
    ctx.fillRect(r - 2, top, 4, yr - top + 2);
    roundRect(ctx, x - 24, top - 10, 48, 19, 4, P.coral);
    ctx.fillStyle = P.mustard;
    for (let i = 0; i < 3; i++) {
      const bx = l + 4 + i * 9;
      ctx.beginPath();
      ctx.moveTo(bx, top + 16);
      ctx.lineTo(bx + 4, top + 26);
      ctx.lineTo(bx + 7, top + 16);
      ctx.closePath();
      ctx.fill();
    }
    this._shadow(ctx, false);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 10px Fredoka, Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, top);
  }

  /** The finish banner, standing on the road where the ride ends. */
  _finish(ctx, t) {
    const x = YOU_X + (this.workout.totalS - t) * PX_PER_S;
    if (x < -40 || x > W + 50) return;
    const l = x - 22;
    const r = x + 22;
    const yl = this.roadY(l, t);
    const yr = this.roadY(r, t);
    const top = Math.min(yl, yr) - 70;
    this._shadow(ctx, true);
    ctx.fillStyle = P.ink;
    ctx.fillRect(l - 2, top, 4, yl - top + 2);
    ctx.fillRect(r - 2, top, 4, yr - top + 2);
    roundRect(ctx, x - 30, top - 14, 60, 28, 5, '#FFFFFF');
    this._shadow(ctx, false);
    // The word on a plain white banner, with one chequered band underneath.
    ctx.fillStyle = P.ink;
    ctx.font = '700 11px Fredoka, Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', x, top - 5);
    for (let row = 0; row < 2; row++) {
      for (let col = row; col < 14; col += 2) ctx.fillRect(x - 28 + col * 4, top + 4 + row * 4, 4, 4);
    }
  }

  _flag(ctx, x, t) {
    const y = this.roadY(x, t);
    this._shadow(ctx, true);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x - 1.5, y - 44, 3, 44);
    ctx.fillStyle = P.coral;
    ctx.beginPath();
    ctx.moveTo(x + 1.5, y - 44);
    ctx.lineTo(x + 18, y - 38);
    ctx.lineTo(x + 1.5, y - 32);
    ctx.closePath();
    ctx.fill();
    this._shadow(ctx, false);
  }

  _rider(ctx, x, t, { ghost, crank, wheel, speedLines }) {
    const y = this.roadY(x, t) + 2;
    const slope = (this.roadY(x + 8, t) - this.roadY(x - 8, t)) / 16;
    const pose = riderPose(crank, this.stand);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan(slope));
    if (ghost) ctx.globalAlpha = 0.8;
    if (speedLines) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      for (const [x0, x1, yy] of [[-46, -32, -20], [-54, -34, -32], [-44, -32, -44]]) line(ctx, x0, yy, x1, yy);
    }
    const colors = ghost
      ? { tyre: P.lavender, frame: P.lavender, far: P.lavender, shorts: P.lavender, skin: P.lavender, jersey: P.lavender, helmet: P.lavender, eye: null }
      : { tyre: P.ink, frame: P.teal, far: '#2A2433', shorts: P.ink, skin: P.skin, jersey: P.coral, helmet: P.mustard, eye: P.ink };

    // Pass 1: white paper outline with a soft shadow. Pass 2: colours on top.
    this._shadow(ctx, true);
    drawRider(ctx, pose, wheel, colors, 3.2);
    this._shadow(ctx, false);
    drawRider(ctx, pose, wheel, colors, 0);
    ctx.restore();
  }

  _tag(ctx, x, y, text, color) {
    ctx.font = '700 10px Fredoka, Nunito, sans-serif';
    const w = Math.max(34, ctx.measureText(text).width + 14);
    x = Math.min(W - w / 2 - 6, Math.max(w / 2 + 6, x));
    this._shadow(ctx, true);
    roundRect(ctx, x - w / 2, y - 9, w, 18, 5, '#FFFFFF');
    this._shadow(ctx, false);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }
}

// --- rider geometry ---------------------------------------------------------

// Each body point seated, and out of the saddle: up and forward over the bars.
const SEATED = { hip: [-8, -34], shoulder: [6, -46], elbow: [12, -39], head: [11, -54] };
const STANDING = { hip: [-3, -40], shoulder: [10, -52], elbow: [14, -42], head: [16, -60] };
const BB = [-4, -11];
const CRANK = 5.5;
const THIGH = 13.5;
const SHIN = 14.5;

function legFor(angle, hip) {
  const foot = [BB[0] + CRANK * Math.cos(angle), BB[1] + CRANK * Math.sin(angle)];
  const dx = foot[0] - hip[0];
  const dy = foot[1] - hip[1];
  const reach = Math.hypot(dx, dy);
  // Standing tall, the leg straightens to reach the bottom of the stroke.
  const k = Math.max(1, (reach + 0.01) / (THIGH + SHIN));
  const thigh = THIGH * k;
  const shin = SHIN * k;
  const base = Math.atan2(dy, dx);
  const a = Math.acos(Math.min(1, (thigh * thigh + reach * reach - shin * shin) / (2 * thigh * reach)));
  const knee = [hip[0] + thigh * Math.cos(base - a), hip[1] + thigh * Math.sin(base - a)];
  return { knee, foot };
}

function riderPose(crank, stand = 0) {
  const mix = (key) => SEATED[key].map((v, i) => v + (STANDING[key][i] - v) * stand);
  // Out of the saddle the body rocks with each pedal stroke.
  const bob = stand * Math.sin(crank * 2) * 1.2;
  const hip = mix('hip');
  hip[1] += bob;
  const shoulder = mix('shoulder');
  shoulder[1] += bob;
  const head = mix('head');
  head[1] += bob;
  return { near: legFor(crank, hip), far: legFor(crank + Math.PI, hip), crank, hip, shoulder, elbow: mix('elbow'), head };
}

function drawRider(ctx, pose, wheel, c, outline) {
  const o = outline;
  const stroke = (color, width) => {
    ctx.strokeStyle = o ? '#FFFFFF' : color;
    ctx.lineWidth = width + o;
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Far leg behind the bike.
  stroke(c.far, 5);
  polyline(ctx, [pose.hip, pose.far.knee, pose.far.foot]);

  // Wheels with turning spokes.
  for (const cx of [-15, 15]) {
    stroke(c.tyre, 3.5);
    ctx.beginPath();
    ctx.arc(cx, -11, 11, 0, Math.PI * 2);
    ctx.stroke();
    if (!o) {
      ctx.strokeStyle = c.tyre;
      ctx.globalAlpha *= 0.5;
      ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const a = wheel + (k * Math.PI) / 3;
        line(ctx, cx - 10 * Math.cos(a), -11 - 10 * Math.sin(a), cx + 10 * Math.cos(a), -11 + 10 * Math.sin(a));
      }
      ctx.globalAlpha /= 0.5;
    }
  }

  // Frame, bars, saddle.
  stroke(c.frame, 4);
  polyline(ctx, [[-15, -11], [-4, -11], [-9, -27], [10, -27], [15, -11]]);
  polyline(ctx, [[-4, -11], [10, -27], [12, -33]]);
  stroke(c.tyre, 3);
  polyline(ctx, [[12, -33], [17, -33], [18, -29]]);
  polyline(ctx, [[-13, -30], [-5, -30]]);

  // Crank.
  stroke(c.tyre, 2.2);
  line(ctx, BB[0] - CRANK * Math.cos(pose.crank), BB[1] - CRANK * Math.sin(pose.crank), pose.near.foot[0], pose.near.foot[1]);

  // Near leg.
  stroke(c.shorts, 6.5);
  polyline(ctx, [pose.hip, pose.near.knee]);
  stroke(c.skin, 4.5);
  polyline(ctx, [pose.near.knee, pose.near.foot]);

  // Body, arm, head, helmet.
  const [sx, sy] = pose.shoulder;
  const [ex, ey] = pose.elbow;
  const [hx, hy] = pose.head;
  stroke(c.jersey, 10);
  line(ctx, pose.hip[0], pose.hip[1], sx, sy);
  stroke(c.jersey, 4.5);
  line(ctx, sx, sy, ex, ey);
  stroke(c.skin, 4);
  line(ctx, ex, ey, 16, -34);
  if (o) {
    circle(ctx, hx, hy, 6.5 + o / 2 + 0.5, '#FFFFFF');
  } else {
    circle(ctx, hx, hy, 6.5, c.skin);
    ctx.fillStyle = c.helmet;
    ctx.beginPath();
    ctx.arc(hx, hy - 1, 7.8, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    if (c.eye) circle(ctx, hx + 3.5, hy + 1.5, 1.1, c.eye);
  }
}

// --- small drawing helpers ---------------------------------------------------

function circle(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function cloud(ctx, x, y, s) {
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.ellipse(x, y, 34 * s, 11 * s, 0, 0, Math.PI * 2);
  ctx.arc(x - 12 * s, y - 8 * s, 12 * s, 0, Math.PI * 2);
  ctx.arc(x + 10 * s, y - 13 * s, 16 * s, 0, Math.PI * 2);
  ctx.fill();
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function polyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function hash(k) {
  const s = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

function tagGap(m) {
  const a = Math.abs(Math.round(m));
  if (a === 0) return '0 m';
  return `${m >= 0 ? '+' : '−'}${a >= 1000 ? (a / 1000).toFixed(1) + ' km' : a + ' m'}`;
}
