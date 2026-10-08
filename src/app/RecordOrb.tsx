"use client";

import { useEffect, useRef } from "react";
import { animate, stagger, steps } from "animejs";

type Props = {
  audioStream: MediaStream | null;
  recording: boolean;
  busy: boolean;
  ready: boolean;
  onReady: () => void;
  onPress: () => void;
};

function arc(radius: number, start: number, end: number) {
  const point = (angle: number) => {
    const radians = (angle - 90) * Math.PI / 180;
    return `${250 + radius * Math.cos(radians)} ${250 + radius * Math.sin(radians)}`;
  };
  return `M ${point(start)} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${point(end)}`;
}

const segments = [
  { start: 0.75, end: 44.25, color: "#ff434e" },
  { start: 45.75, end: 89.25, color: "#ffb92e" },
  { start: 90.75, end: 134.25, color: "#15e8a3" },
  { start: 135.75, end: 179.25, color: "#358fff" },
  { start: 180.75, end: 224.25, color: "#16d5e7" },
  { start: 225.75, end: 269.25, color: "#8bff40" },
  { start: 270.75, end: 314.25, color: "#ffcf29" },
  { start: 315.75, end: 359.25, color: "#7cff45" },
];
const ringBlinkDelays = [240, 0, 310, 70, 380, 130, 290, 40];

const ticks = Array.from({ length: 144 }, (_, index) => {
  const angle = index * 2.5 * Math.PI / 180;
  return { x1: 250 + 207 * Math.sin(angle), y1: 250 - 207 * Math.cos(angle), x2: 250 + 220 * Math.sin(angle), y2: 250 - 220 * Math.cos(angle) };
});

const waveLines = Array.from({ length: 67 }, (_, index) => {
  const y = 132 + index * 3.55;
  const centered = Math.abs(y - 250) / 119;
  const width = 166 * Math.pow(Math.max(0, 1 - centered * centered), 0.72) * (0.92 + 0.08 * Math.cos(index * 0.41));
  return { y, width: Math.max(1.5, width) };
});

const dots = Array.from({ length: 39 }, (_, index) => {
  const progress = index / 38;
  return { x: 88 + progress * 324, y: 355 - progress * 210 + Math.sin(progress * Math.PI * 2) * 29 };
});

export default function RecordOrb({ audioStream, recording, busy, ready, onReady, onPress }: Props) {
  const root = useRef<HTMLButtonElement>(null);
  const onReadyRef = useRef(onReady);
  const ambientMotion = useRef<Array<{ pause: () => void; play: () => void }>>([]);
  onReadyRef.current = onReady;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      element.classList.add("orb-reduced");
      onReadyRef.current();
      return;
    }

    const animations = [
      animate(element.querySelectorAll(".orb-tick"), { opacity: [0, 0.7], delay: stagger(7), duration: 360, ease: "outQuad" }),
      animate(element.querySelectorAll(".orb-shell"), { opacity: [0, 1], delay: 570, duration: 760, ease: "outSine" }),
      animate(element.querySelectorAll(".orb-segment"), {
        opacity: [0, 1, 0, 1, 0, 1],
        delay: (_, index) => 760 + ringBlinkDelays[index ?? 0],
        duration: 200,
        ease: steps(5),
      }),
      animate(element.querySelectorAll(".orb-inner"), { opacity: [0, 1], delay: 1450, duration: 780, ease: "outSine" }),
    ];
    const entrance = window.setTimeout(() => {
      onReadyRef.current();
      const outer = element.querySelector(".orb-outer-rotation");
      if (outer) animations.push(animate(outer, { rotate: "1turn", duration: 38000, loop: true, ease: "linear" }));
      const waveMotion = animate(element.querySelectorAll(".orb-wave-line"), { scaleX: [0.8, 1], delay: stagger(22), duration: 2200, alternate: true, loop: true, ease: "inOutSine" });
      const dotMotion = animate(element.querySelectorAll(".orb-dot"), { y: [-7, 7], delay: stagger(35), duration: 2500, alternate: true, loop: true, ease: "inOutSine" });
      animations.push(waveMotion, dotMotion);
      ambientMotion.current = [waveMotion, dotMotion];
    }, 2450);
    return () => { window.clearTimeout(entrance); animations.forEach(animation => animation.pause()); ambientMotion.current = []; };
  }, []);

  useEffect(() => {
    ambientMotion.current.forEach(animation => recording ? animation.pause() : animation.play());
  }, [recording]);

  useEffect(() => {
    const element = root.current;
    if (!element || !recording || !audioStream) return;

    const lines = Array.from(element.querySelectorAll<SVGLineElement>(".orb-wave-line"));
    const circles = Array.from(element.querySelectorAll<SVGCircleElement>(".orb-dot"));
    let context: AudioContext;
    let frame = 0;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      const source = context.createMediaStreamSource(audioStream);
      source.connect(analyser);
      const frequency = new Uint8Array(analyser.frequencyBinCount);
      const waveform = new Uint8Array(analyser.fftSize);
      const dotPositions = dots.map(dot => dot.y);
      void context.resume();
      let lastDraw = 0;
      let smoothedLevel = 0;

      const draw = (time: number) => {
        frame = requestAnimationFrame(draw);
        if (time - lastDraw < 16) return;
        lastDraw = time;
        analyser.getByteFrequencyData(frequency);
        analyser.getByteTimeDomainData(waveform);

        let sumSquares = 0;
        for (const value of waveform) {
          const sample = (value - 128) / 128;
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / waveform.length);
        const targetLevel = Math.min(1, Math.max(0, (rms - 0.008) / 0.05));
        smoothedLevel += (targetLevel - smoothedLevel) * 0.2;

        lines.forEach((line, index) => {
          const progress = index / Math.max(1, lines.length - 1);
          const bin = Math.min(frequency.length - 1, 2 + Math.round(Math.pow(progress, 1.45) * 105));
          const signal = Math.min(1, Math.max(0, (frequency[bin] / 255 - 0.07) / 0.55));
          const lineY = (waveLines[index].y - 250) * 1.18;
          const insideCircleWidth = Math.sqrt(Math.max(0, 180 * 180 - lineY * lineY));
          const width = Math.min(insideCircleWidth, waveLines[index].width * (0.2 + signal * 0.92));
          line.setAttribute("x1", String(250 - width));
          line.setAttribute("x2", String(250 + width));
          line.setAttribute("opacity", String(0.35 + signal * 0.55));
        });

        circles.forEach((circle, index) => {
          const sampleIndex = Math.round(index / Math.max(1, circles.length - 1) * (waveform.length - 1));
          let sample = 0;
          let samples = 0;
          for (let offset = -2; offset <= 2; offset++) {
            const value = waveform[Math.max(0, Math.min(waveform.length - 1, sampleIndex + offset))];
            sample += (value - 128) / 128;
            samples++;
          }
          sample /= samples;
          const targetY = 250 - sample * 78 * smoothedLevel;
          dotPositions[index] += (targetY - dotPositions[index]) * 0.34;
          circle.setAttribute("cy", String(dotPositions[index]));
          circle.setAttribute("r", String(3.6 + Math.abs(sample) * smoothedLevel * 2.2));
        });
      };
      frame = requestAnimationFrame(draw);
    } catch {
      return;
    }

    return () => {
      cancelAnimationFrame(frame);
      lines.forEach((line, index) => {
        const width = waveLines[index].width;
        line.setAttribute("x1", String(250 - width));
        line.setAttribute("x2", String(250 + width));
        line.setAttribute("opacity", "0.76");
      });
      circles.forEach((circle, index) => {
        circle.setAttribute("cy", String(dots[index].y));
        circle.setAttribute("r", "3.6");
      });
      void context.close();
    };
  }, [audioStream, recording]);

  return <button
    ref={root}
    type="button"
    className={`record-orb ${recording ? "is-recording" : ""}`}
    aria-label={recording ? "Stop recording" : busy ? "Recording is processing" : "Start recording"}
    aria-pressed={recording}
    disabled={!ready || (busy && !recording)}
    onClick={onPress}
  >
    <svg viewBox="0 0 500 500" aria-hidden="true" focusable="false">
      <g className="orb-shell">
        <circle cx="250" cy="250" r="242" fill="#191919" />
        <circle cx="250" cy="250" r="222" fill="none" stroke="#101010" strokeWidth="12" />
        <circle cx="250" cy="250" r="207" fill="#171717" stroke="#292929" strokeWidth="3" />
      </g>
      <g className="orb-outer-rotation">
        {segments.map((segment, index) => <path key={index} className="orb-segment" d={arc(232, segment.start, segment.end)} fill="none" stroke={segment.color} strokeWidth="4.2" strokeLinecap="round" />)}
      </g>
      <g>{ticks.map((tick, index) => <line key={index} className="orb-tick" {...tick} stroke="#bd353d" strokeWidth="1.5" />)}</g>
      <g className="orb-inner">
        <circle cx="250" cy="250" r="196" fill="#1a1a1a" stroke="#0d0d0d" strokeWidth="7" />
        <circle cx="250" cy="250" r="187" fill="none" stroke="#303030" strokeWidth="1" />
        <path d={arc(171, 286, 340)} fill="none" stroke="#494444" strokeWidth="17" opacity="0.85" />
        <path d={arc(187, 98, 164)} fill="none" stroke="#f4a995" strokeWidth="2" opacity="0.9" />
        <path d={arc(178, 103, 160)} fill="none" stroke="#f4a995" strokeWidth="1.5" opacity="0.7" />
        <g className="orb-wave">
          {waveLines.map((line, index) => <line key={index} className="orb-wave-line" x1={250 - line.width} x2={250 + line.width} y1={line.y} y2={line.y} stroke="#d13c43" strokeWidth="1.5" opacity="0.76" />)}
        </g>
        <g>{dots.map((dot, index) => <circle key={index} className="orb-dot" cx={dot.x} cy={dot.y} r="3.6" fill="#f1464d" />)}</g>
      </g>
    </svg>
    <span className="sr-only">{recording ? "Stop recording" : "Start recording"}</span>
  </button>;
}
