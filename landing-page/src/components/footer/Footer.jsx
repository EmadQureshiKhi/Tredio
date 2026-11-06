"use client";
import React, { useState, useRef, useEffect } from "react";
import { gsap } from "gsap";
import Link from "next/link";
import { CONTACT_EMAIL, LEGAL_LINKS, NAV_ITEMS } from "@/config/links";
import { WIDE_VIEWBOX, WIDE_WORD } from "@/components/brand/Logo";
import useSectionNav from "@/components/hooks/useSectionNav";
import ScrollTrigger from "gsap/dist/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);

const Footer = () => {
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const animatedPos = useRef({ x: 0, y: 0 });
  const circleRef = useRef(null);
  const containerRef = useRef(null);

  const [hoveredIndex, setHoveredIndex] = useState(null);
  const goToSection = useSectionNav();

  const navItems = NAV_ITEMS;

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.to("#footer-wrapper", {
        yPercent: 0,
        ease: "none",
        scrollTrigger: {
          trigger: "#footer-wrapper",
          start: "top bottom",
          end: "bottom 50%",
          scrub: true,
          immediateRender: false,
        },
      });
    });
    ScrollTrigger.refresh();
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && containerRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      const containerHeight = containerRef.current.offsetHeight;
      const initialX = containerWidth / 2;
      const initialY = containerHeight * 0.75;
      setMousePos({ x: initialX, y: initialY });
      animatedPos.current = { x: initialX, y: initialY };
    }
  }, []);

  useEffect(() => {
    gsap.to(animatedPos.current, {
      x: mousePos.x,
      y: mousePos.y,
      duration: 0.6,
      ease: "power2.out",
      onUpdate: () => {
        if (circleRef.current && containerRef.current) {
          const containerWidth = containerRef.current.offsetWidth;
          // Hidden (the phone layout shows MobileFooter instead): nothing to position.
          if (!containerWidth) return;
          const svgX = (animatedPos.current.x / containerWidth) * 1856;
          circleRef.current.setAttribute("x", svgX - 464);
        }
      },
    });
  }, [mousePos]);

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div
      className="h-fit w-full relative z-12 bg-black "
      id="footer-wrapper"
      style={{ transform: "translateY(0%)" }}
    >
      <footer
        ref={containerRef}
        className="w-full h-screen mt-0 pointer-events-auto sticky top-0 bg-[#1E1E1E] flex flex-col items-stretch justify-between p-[2vw]"
        onMouseMove={handleMouseMove}
      >
        {/* TOP SECTION */}
        <div className="w-full h-[60%] bg-[#1E1E1E] flex justify-between items-start text-white">
          <div className="flex flex-col justify-center h-full">
            <p className="text-[4vw] font-third leading-[1.2]">
              Trade the <br /> World&apos;s Attention
            </p>
            <div className="text-[clamp(13px,1vw,18px)] leading-[1.6] text-gray-300 mt-auto">
              <p>Attention markets on NEAR</p>
              <p>Settled in USDC</p>
              <a href={`mailto:${CONTACT_EMAIL}`} className="mt-[0.8vw] inline-block text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-[#9C93E8]">
                {CONTACT_EMAIL}
              </a>
            </div>
          </div>

          {/* RIGHT SIDE MENU WITH ANIMATION */}
          <div className="flex justify-between opacity-90 h-full px-[4vw] w-[30vw]">
            {/* EXPLORE */}
            <div className="flex flex-col">
              <span className="uppercase text-[clamp(10px,0.7vw,13px)] font-semibold mb-[1vw] tracking-[0.12em]">
                Explore
              </span>
              <ul className="font-display text-[2vw] leading-[1.4vw] space-y-[0.6vw]">
                {navItems.map((item, i) => (
                  <li
                    key={i}
                    className={`leading-none transition-opacity duration-300 ${
                      hoveredIndex !== null && hoveredIndex !== i
                        ? "opacity-50"
                        : "opacity-100"
                    }`}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {item.scrollTo ? (
                      <button
                        onClick={() => goToSection(item.scrollTo)}
                        className="cursor-pointer transition-colors duration-300 hover:text-[#9C93E8]"
                      >
                        {item.title}
                      </button>
                    ) : (
                      <Link
                        href={item.href}
                        target={item.newTab ? "_blank" : undefined}
                        rel={item.newTab ? "noopener noreferrer" : undefined}
                        className="cursor-pointer transition-colors duration-300 hover:text-[#9C93E8]"
                      >
                        {item.title}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="w-full h-[3vw] text-white/80 flex justify-between ">
          <nav aria-label="Legal" className="flex gap-[2vw] items-center">
            {LEGAL_LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="h-[var(--line)] relative group overflow-hidden cursor-pointer hover:text-white [--line:clamp(14px,1vw,18px)]"
              >
                <span className="flex h-[calc(var(--line)*2)] w-full flex-col items-start justify-end transition-none group-hover:-translate-y-[var(--line)] group-hover:transition-transform group-hover:duration-300">
                  <span className="text-[clamp(10px,0.7vw,13px)] leading-[var(--line)] uppercase tracking-[0.06em] font-body font-semibold">
                    {item.title}
                  </span>
                  <span aria-hidden="true" className="text-[clamp(10px,0.7vw,13px)] leading-[var(--line)] uppercase tracking-[0.06em] font-semibold font-body">
                    {item.title}
                  </span>
                </span>
              </Link>
            ))}
          </nav>

          <div className="items-center flex gap-[1.5vw] pr-[5vw]">
            <span className="text-[clamp(10px,0.7vw,13px)] uppercase tracking-[0.06em] font-body font-semibold">
              &copy; 2026 Tredio
            </span>
          </div>
        </div>

        {/* BOTTOM SVG SECTION */}
        <div className="relative w-full h-[27%] bg-[#1E1E1E] overflow-hidden">
          {/* BASE SVG */}
          <svg
            aria-hidden="true"
            preserveAspectRatio="xMidYMax meet"
            width="100%"
            height="100%"
            viewBox={WIDE_VIEWBOX}
            className="absolute inset-0 w-full h-full"
          >
            <path d={WIDE_WORD} fill="#1E1E1E" />
          </svg>

          {/* MASKED SVG */}
          <svg
            aria-hidden="true"
            preserveAspectRatio="xMidYMax meet"
            width="100%"
            height="100%"
            viewBox={WIDE_VIEWBOX}
            className="absolute inset-0 w-full h-full"
          >
            <defs>
              <linearGradient
                id="fadeGradient"
                x1="0%"
                y1="0%"
                x2="100%"
                y2="0%"
              >
                <stop offset="0%" stopColor="white" stopOpacity="0" />
                <stop offset="10%" stopColor="white" stopOpacity="0.3" />
                <stop offset="50%" stopColor="white" stopOpacity="1" />
                <stop offset="90%" stopColor="white" stopOpacity="0.3" />
                <stop offset="100%" stopColor="white" stopOpacity="0" />
              </linearGradient>
              <mask id="cursorMask">
                <rect width="100%" height="100%" fill="black" />
                <rect
                  ref={circleRef}
                  x="528"
                  y="0"
                  width="1300"
                  height="304"
                  fill="url(#fadeGradient)"
                />
              </mask>
            </defs>
            <g mask="url(#cursorMask)">
              <path d={WIDE_WORD} fill="#9C93E8" />
            </g>
          </svg>
        </div>
      </footer>
    </div>
  );
};

export default Footer;
