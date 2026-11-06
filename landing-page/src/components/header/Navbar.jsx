"use client";
import React, { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { gsap } from "gsap";
import { useLenis } from "lenis/react";
import { APP_URL, NAV_ITEMS } from "@/config/links";
import useSectionNav from "@/components/hooks/useSectionNav";

// A label that rolls to its twin on hover, used by the menu and Launch App tabs.
function RollLabel({ children, className = "" }) {
  return (
    <span className={`relative flex h-[var(--roll)] overflow-hidden [--roll:clamp(14px,1vw,18px)] max-sm:[--roll:18px] ${className}`}>
      <span className="flex flex-col transition-transform duration-300 group-hover:-translate-y-[var(--roll)]">
        <span className="block font-body text-[clamp(10px,0.7vw,13px)] leading-[var(--roll)] font-semibold tracking-[0.08em] text-black max-sm:text-[12px]">
          {children}
        </span>
        <span aria-hidden="true" className="block font-body text-[clamp(10px,0.7vw,13px)] leading-[var(--roll)] font-semibold tracking-[0.08em] text-black max-sm:text-[12px]">
          {children}
        </span>
      </span>
    </span>
  );
}

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [hasAnimated, setHasAnimated] = useState(false);
  const menuOverlayRef = useRef(null);

  const lenis = useLenis();
  const goToSection = useSectionNav();

  useEffect(() => {
    gsap.set(".nav-menu-item", { yPercent: -100 });
    const ctx = gsap.context(() => {
      gsap.fromTo(".nav-menu-item-first", { yPercent: -100 }, { yPercent: 0, delay: 0.5, ease: "power2.out", duration: 0.4 });
      gsap.fromTo(".nav-menu-item", { yPercent: -100 }, { yPercent: 0, stagger: 0.2, duration: 0.7, ease: "power2.out", delay: 1 });
    });
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    if (!lenis) return;
    if (menuOpen) lenis.stop();
    else lenis.start();
  }, [menuOpen, lenis]);

  const handleNavClick = (item) => {
    setMenuOpen(false);
    if (item.scrollTo) {
      setTimeout(() => goToSection(item.scrollTo, { offset: 0 }), 400);
    }
  };

  useEffect(() => {
    const overlay = menuOverlayRef.current;
    if (!overlay) return;

    const ctx = gsap.matchMedia();

    ctx.add("(max-width: 639px)", () => {
      // Phones: a sidebar sliding in from the left.
      gsap.set(overlay, { clipPath: "none" });
      if (menuOpen) {
        gsap.fromTo(overlay, { x: "-100%" }, { x: "0%", duration: 0.4, ease: "power2.out" });
      } else {
        gsap.to(overlay, { x: "-100%", duration: 0.35, ease: "power2.in" });
      }
    });

    ctx.add("(min-width: 640px)", () => {
      // Wider screens: a circle opening from the top left corner.
      gsap.set(overlay, { x: "0%" });
      const closedClip = "circle(0% at 0% 0%)";
      const openClip = "circle(160% at 0% 0%)";
      if (menuOpen) {
        gsap.fromTo(overlay, { clipPath: closedClip }, { clipPath: openClip, duration: 0.8, ease: "power1.inOut" });
      } else {
        gsap.to(overlay, { clipPath: closedClip, duration: 0.8, ease: "power1.inOut" });
      }
    });

    return () => ctx.revert();
  }, [menuOpen]);

  // Hovering the menu button replays the hamburger lines' draw-in.
  const handleMenuHover = () => {
    if (!hasAnimated) {
      setHasAnimated(true);
      setTimeout(() => setHasAnimated(false), 500);
    }
  };

  const tab = "h-[clamp(40px,3vw,56px)] bg-[#9C93E8] max-sm:h-[46px]";

  return (
    <header id="site-header">
      {/* The logo, centred, drawn in the inverse of whatever is behind it. */}
      <div className="w-full flex items-center origin-top nav-menu-item-first justify-center fixed top-0 z-9999 h-[clamp(40px,3vw,56px)] mix-blend-exclusion invert pointer-events-none max-sm:h-[46px]">
        <Link href="/" aria-label="Tredio home" className="flex h-[clamp(14px,1.05vw,20px)] items-center pointer-events-auto max-sm:h-[16px]">
          <Image src="/assets/svg/tredio-icon-logo.svg" alt="" width={362} height={72} priority className="h-full w-auto invert" />
        </Link>
      </div>

      <nav id="site-nav" aria-label="Site" className="fixed top-0 left-0 right-0 w-full flex items-start justify-between z-9999 pointer-events-none">
        {/* Left: menu */}
        <button
          type="button"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
          onMouseEnter={handleMenuHover}
          className={`${tab} nav-menu-item group relative z-10000 flex items-center gap-[clamp(10px,1vw,18px)] overflow-hidden rounded-br-[clamp(10px,1vw,18px)] px-[clamp(14px,1.5vw,28px)] pointer-events-auto cursor-pointer outline-none max-sm:px-4`}
        >
          <span aria-hidden="true" className="relative flex w-[clamp(14px,1vw,18px)] flex-col justify-start gap-[clamp(3px,0.25vw,4px)]">
            <span
              className={`block h-[1.5px] bg-black origin-left transition-transform duration-100 ease-in-out ${hasAnimated ? "scale-x-0" : "scale-x-100"} ${
                menuOpen ? "rotate-45 w-[70%]" : "w-full"
              }`}
            />
            <span
              className={`block h-[1.5px] bg-black origin-left transition-transform duration-500 delay-100 ease-in-out ${hasAnimated ? "scale-x-0" : "scale-x-100"} ${
                menuOpen ? "-rotate-45 w-[70%]" : "w-full"
              }`}
            />
          </span>
          <RollLabel className="max-sm:hidden">{menuOpen ? "CLOSE" : "MENU"}</RollLabel>
        </button>

        {/* Right: Launch App */}
        <Link
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`${tab} nav-menu-item group relative z-10002 flex items-center justify-center overflow-hidden rounded-bl-[clamp(10px,1vw,18px)] px-[clamp(14px,1.5vw,28px)] pointer-events-auto cursor-pointer outline-none max-sm:z-[9998] max-sm:px-4`}
        >
          <RollLabel>LAUNCH APP</RollLabel>
        </Link>

        {/* MENU OVERLAY */}
        <div
          ref={menuOverlayRef}
          className="fixed top-0 left-0 z-[9999] w-[128vw] h-[125vh] rounded-br-full overflow-hidden max-sm:w-[78vw] max-sm:h-dvh max-sm:rounded-none max-sm:shadow-2xl"
          style={{ clipPath: "circle(0% at 0% 0%)" }}
        >
          <div
            className={`w-full h-full navbar-clip-path transition-all duration-700 max-sm:!bg-white max-sm:![clip-path:none] origin-top-left ${
              menuOpen ? "pointer-events-auto" : "pointer-events-none"
            }`}
          >
            <div className="flex flex-col items-end justify-end mr-[29vw] pb-[calc(25vh+3vw)] h-full max-sm:mr-0 max-sm:px-[8vw] max-sm:items-start max-sm:justify-start max-sm:pt-[96px] max-sm:pb-[10vw]">
              <ul className="flex flex-col items-end text-right max-sm:items-start max-sm:text-left max-sm:gap-[2vw]">
                {NAV_ITEMS.map((item, i) => (
                  <li
                    key={item.title}
                    className={`leading-[1.08] transition-opacity ease-in-out duration-300 ${
                      hoveredIndex !== null && hoveredIndex !== i ? "opacity-50" : "opacity-100"
                    }`}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {item.scrollTo ? (
                      <button
                        type="button"
                        tabIndex={menuOpen ? 0 : -1}
                        onClick={() => handleNavClick(item)}
                        className="font-third text-[clamp(32px,4vw,72px)] tracking-[-0.02em] cursor-pointer text-black max-sm:text-[8vw]"
                      >
                        {item.title}
                      </button>
                    ) : (
                      <Link
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        tabIndex={menuOpen ? 0 : -1}
                        className="font-third text-[clamp(32px,4vw,72px)] tracking-[-0.02em] cursor-pointer text-black max-sm:text-[8vw]"
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

        {/* Dims the page behind the open menu. */}
        <div
          className={`fixed inset-0 bg-black transition-opacity duration-700 ${menuOpen ? "opacity-60" : "opacity-0"} pointer-events-none z-[9998]`}
        />
      </nav>
    </header>
  );
}
