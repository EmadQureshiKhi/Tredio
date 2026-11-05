"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { gsap } from "gsap";
import Navbar from "@/components/header/Navbar";
import { APP_URL } from "@/config/links";

const chartData = [44, 47, 45, 50, 48, 46, 49, 47, 44, 41, 36, 29, 21, 15, 11, 9, 8, 8, 8, 8, 8];

function FlatlineChart() {
  const pathRef = useRef(null);
  const dotRef = useRef(null);
  const fillRef = useRef(null);

  const W = 600;
  const H = 60;
  const max = Math.max(...chartData);
  const min = Math.min(...chartData);
  const range = max - min || 1;
  const step = W / (chartData.length - 1);

  const coords = chartData.map((val, i) => ({
    x: parseFloat((i * step).toFixed(2)),
    y: parseFloat((H - ((val - min) / range) * (H - 10) - 5).toFixed(2)),
  }));

  const linePath = coords.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const fillPath = `${linePath} L${W},${H} L0,${H} Z`;
  const last = coords[coords.length - 1];

  useEffect(() => {
    if (!pathRef.current) return;
    const length = pathRef.current.getTotalLength();
    gsap.set(pathRef.current, { strokeDasharray: length, strokeDashoffset: length, opacity: 1 });
    gsap.set(fillRef.current, { opacity: 0 });
    gsap.set(dotRef.current, { scale: 0, opacity: 0, transformOrigin: "center center" });

    gsap.to(pathRef.current, {
      strokeDashoffset: 0,
      duration: 2,
      ease: "power2.inOut",
      delay: 1.2,
    });
    gsap.to(fillRef.current, {
      opacity: 1,
      duration: 0.5,
      delay: 2.8,
    });
    gsap.to(dotRef.current, {
      scale: 1,
      opacity: 1,
      duration: 0.35,
      delay: 3.2,
      ease: "back.out(2.5)",
    });
  }, []);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      preserveAspectRatio="none"
      style={{ height: "clamp(36px, 4.5vw, 72px)" }}
    >
      <defs>
        <linearGradient id="grad-lp-404" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#EF4444" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path ref={fillRef} d={fillPath} fill="url(#grad-lp-404)" />
      <path
        ref={pathRef}
        d={linePath}
        fill="none"
        stroke="#EF4444"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0"
      />
      <circle ref={dotRef} cx={last.x} cy={last.y} r="4" fill="#EF4444" />
    </svg>
  );
}

export default function NotFound() {
  const badgeRef = useRef(null);
  const headingRef = useRef(null);
  const chartWrapRef = useRef(null);
  const titleRef = useRef(null);
  const descRef = useRef(null);
  const ctaRef = useRef(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

      tl.fromTo(
        badgeRef.current,
        { yPercent: 30, opacity: 0 },
        { yPercent: 0, opacity: 1, duration: 0.6, delay: 0.3 }
      )
        .fromTo(
          headingRef.current,
          { yPercent: 40, opacity: 0 },
          { yPercent: 0, opacity: 1, duration: 0.9 },
          "-=0.2"
        )
        .fromTo(
          chartWrapRef.current,
          { scaleX: 0, opacity: 0, transformOrigin: "left center" },
          { scaleX: 1, opacity: 1, duration: 0.8, ease: "power2.inOut" },
          "-=0.4"
        )
        .fromTo(
          [titleRef.current, descRef.current],
          { yPercent: 20, opacity: 0 },
          { yPercent: 0, opacity: 1, duration: 0.6, stagger: 0.12 },
          "-=0.3"
        )
        .fromTo(
          ctaRef.current,
          { yPercent: 20, opacity: 0 },
          { yPercent: 0, opacity: 1, duration: 0.5 },
          "-=0.2"
        );
    });

    return () => ctx.revert();
  }, []);

  return (
    <main className="min-h-screen bg-[#09090B] overflow-hidden flex flex-col">
      <Navbar />

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
        .dot-blink { animation: blink 1.8s ease-in-out infinite; }
      `}</style>

      <div className="flex-1 flex flex-col items-center justify-center px-[5vw] pb-[8vw] pt-[12vw] max-sm:pt-[28vw] max-sm:pb-[15vw]">
        {/* Status badge */}
        <div ref={badgeRef} className="mb-[1.5vw] max-sm:mb-[5vw]">
          <span
            className="inline-flex items-center gap-[0.5vw] px-[0.8vw] py-[0.35vw] rounded-full border border-[#EF4444]/20 bg-[#EF4444]/[0.07] text-[#EF4444] font-body tracking-[0.18em] uppercase max-sm:px-[3vw] max-sm:py-[1.5vw] max-sm:gap-[2vw]"
            style={{ fontSize: "clamp(9px, 0.65vw, 11px)" }}
          >
            <span
              className="dot-blink rounded-full bg-[#EF4444]"
              style={{ width: "clamp(5px, 0.4vw, 7px)", height: "clamp(5px, 0.4vw, 7px)" }}
            />
            POSITION CLOSED
          </span>
        </div>

        {/* 404 */}
        <div ref={headingRef} className="overflow-hidden">
          <h1
            className="font-third leading-none text-center select-none"
            style={{
              fontSize: "clamp(80px, 22vw, 300px)",
              letterSpacing: "-0.03em",
              background: "linear-gradient(160deg, #ffffff 25%, rgba(255,255,255,0.12) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            404
          </h1>
        </div>

        {/* Chart */}
        <div
          ref={chartWrapRef}
          className="w-full mb-[2.5vw] max-sm:mb-[8vw]"
          style={{ maxWidth: "clamp(280px, 55vw, 720px)" }}
        >
          <FlatlineChart />
        </div>

        {/* Title */}
        <h2
          ref={titleRef}
          className="font-third text-center text-white/90 mb-[1vw] max-sm:mb-[3vw]"
          style={{ fontSize: "clamp(18px, 2.4vw, 42px)" }}
        >
          Market Not Found
        </h2>

        {/* Desc */}
        <p
          ref={descRef}
          className="font-body text-white/35 text-center mb-[4vw] max-sm:mb-[10vw] max-sm:max-w-[80vw]"
          style={{
            fontSize: "clamp(12px, 0.9vw, 16px)",
            lineHeight: "1.7",
            maxWidth: "clamp(260px, 30vw, 480px)",
          }}
        >
          This page has been liquidated from existence.
          <br />
          The market you&apos;re looking for doesn&apos;t exist.
        </p>

        {/* CTA buttons */}
        <div
          ref={ctaRef}
          className="flex items-center gap-[1vw] max-sm:gap-[3vw] max-sm:flex-col max-sm:w-full max-sm:max-w-[80vw]"
        >
          {/* Primary */}
          <Link
            href="/"
            className="group relative flex justify-center overflow-hidden cursor-pointer outline-none bg-[#9C93E8] hover:bg-[#B3ABF0] transition-colors duration-200 max-sm:w-full"
            style={{
              padding: "clamp(10px, 0.65vw, 14px) clamp(20px, 2.2vw, 36px)",
              borderRadius: "clamp(6px, 0.5vw, 10px)",
            }}
          >
            <div
              className="flex flex-col group-hover:-translate-y-[1.4vw] transition-transform duration-300 gap-[0.2vw] items-center justify-center"
              style={{ maxHeight: "clamp(16px, 1.1vw, 20px)", overflow: "hidden" }}
            >
              <span
                className="block font-body font-semibold text-black tracking-[0.1em] leading-none"
                style={{ fontSize: "clamp(10px, 0.7vw, 13px)" }}
              >
                BACK TO HOME
              </span>
              <span
                className="block font-body font-semibold text-black tracking-[0.1em] leading-none"
                style={{ fontSize: "clamp(10px, 0.7vw, 13px)" }}
                aria-hidden="true"
              >
                BACK TO HOME
              </span>
            </div>
          </Link>

          {/* Secondary */}
          <Link
            href={APP_URL}
            className="group relative flex justify-center overflow-hidden cursor-pointer outline-none border border-white/[0.10] hover:border-white/20 transition-colors duration-200 max-sm:w-full"
            style={{
              padding: "clamp(10px, 0.65vw, 14px) clamp(20px, 2.2vw, 36px)",
              borderRadius: "clamp(6px, 0.5vw, 10px)",
            }}
          >
            <div
              className="flex flex-col group-hover:-translate-y-[1.4vw] transition-transform duration-300 gap-[0.2vw] items-center justify-center"
              style={{ maxHeight: "clamp(16px, 1.1vw, 20px)", overflow: "hidden" }}
            >
              <span
                className="block font-body font-semibold text-white/50 group-hover:text-white tracking-[0.1em] leading-none transition-colors duration-200"
                style={{ fontSize: "clamp(10px, 0.7vw, 13px)" }}
              >
                LAUNCH APP
              </span>
              <span
                className="block font-body font-semibold text-white/50 tracking-[0.1em] leading-none"
                style={{ fontSize: "clamp(10px, 0.7vw, 13px)" }}
                aria-hidden="true"
              >
                LAUNCH APP
              </span>
            </div>
          </Link>
        </div>
      </div>
    </main>
  );
}
