"use client";
import React, { useEffect, useRef } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import Image from "next/image";

gsap.registerPlugin(ScrollTrigger);

/**
 * The Signal card's picture: one tile per data partner, stacked, with only the
 * first visible. On desktop the Categories timeline cross-fades the tiles (class "signal-logo",
 * with autoAlpha so a hidden tile cannot take clicks)
 * while the card is pinned. With `selfScroll` (the mobile layout, which does not pin) the tiles
 * follow this element's own progress through the viewport.
 */
// A partner logo, sized inside its tile. With `href` the logo links to the partner's site.
const LogoMark = ({ logo }) => {
  const image = (
    <Image
      src={logo.src}
      alt={logo.href ? "" : logo.name}
      fill
      sizes="(max-width: 640px) 50vw, 20vw"
      className="object-contain"
    />
  );
  const box = { width: logo.width ?? "56%", height: logo.height ?? "30%" };
  if (!logo.href) {
    return (
      <div className="relative" style={box}>
        {image}
      </div>
    );
  }
  return (
    <a
      href={logo.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={logo.name}
      className="relative block pointer-events-auto"
      style={box}
    >
      {image}
    </a>
  );
};

// A partner named in text on a badge in its own colours, for a partner without a logo we may show.
const TextMark = ({ mark }) => {
  const badge = (
    <span
      className="block font-bold leading-none whitespace-nowrap text-[1.7vw] px-[0.9vw] py-[0.55vw] max-sm:text-[17px] max-sm:px-[9px] max-sm:py-[6px]"
      style={{ color: mark.color, backgroundColor: mark.background, fontFamily: "Verdana, Geneva, sans-serif" }}
    >
      {mark.text}
    </span>
  );
  if (!mark.href) return badge;
  return (
    <a href={mark.href} target="_blank" rel="noopener noreferrer" className="block pointer-events-auto">
      {badge}
    </a>
  );
};

// Several partners on one tile, stacked and centred, `gap` apart.
const MarkStack = ({ logo }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap: logo.gap ?? "6%" }}>
    {logo.marks.map((mark) =>
      mark.text ? <TextMark key={mark.name} mark={mark} /> : <LogoMark key={mark.name} logo={mark} />,
    )}
  </div>
);

const SignalLogos = ({ logos, selfScroll = false, className = "" }) => {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!selfScroll || !rootRef.current) return;
    const root = rootRef.current;
    const tiles = gsap.utils.toArray(".signal-logo", root);
    let active = 0;
    const show = (index) => {
      if (index === active) return;
      gsap.to(tiles[active], { autoAlpha: 0, duration: 0.35, ease: "power2.out", overwrite: "auto" });
      gsap.to(tiles[index], { autoAlpha: 1, duration: 0.35, ease: "power2.out", overwrite: "auto" });
      active = index;
    };
    const trigger = ScrollTrigger.create({
      trigger: root,
      start: "top 80%",
      end: "top 20%",
      onUpdate: (self) => show(Math.min(tiles.length - 1, Math.floor(self.progress * tiles.length))),
    });
    return () => trigger.kill();
  }, [selfScroll]);

  return (
    <div ref={rootRef} className={`card-image relative w-full h-full overflow-hidden ${className}`}>
      {logos.map((logo, i) => (
        <figure
          key={logo.name}
          className="signal-logo absolute inset-0 m-0 flex items-center justify-center"
          style={{
            backgroundColor: logo.background,
            opacity: i === 0 ? 1 : 0,
            visibility: i === 0 ? "visible" : "hidden",
          }}
        >
          {logo.cover ? (
            <Image src={logo.cover} alt={logo.name} fill sizes="(max-width: 640px) 90vw, 40vw" className="object-cover" />
          ) : logo.marks ? (
            <MarkStack logo={logo} />
          ) : logo.src ? (
            <LogoMark logo={logo} />
          ) : (
            <span
              className="font-third text-center leading-[1.05] text-[3vw] max-sm:text-[30px] px-[8%]"
              style={{ color: logo.foreground ?? "#ffffff" }}
            >
              {logo.text}
            </span>
          )}
          <figcaption
            className="absolute left-0 right-0 bottom-0 flex items-end justify-between gap-3 px-[2.4vw] pb-[2vw] max-sm:px-5 max-sm:pb-4 font-body uppercase tracking-[0.14em] text-[0.75vw] max-sm:text-[11px]"
            style={{ color: logo.foreground ?? "#ffffff" }}
          >
            <span className="font-semibold">{logo.role}</span>
            <span className="opacity-75 tabular-nums whitespace-nowrap">
              {String(i + 1).padStart(2, "0")} / {String(logos.length).padStart(2, "0")}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
};

export default SignalLogos;
