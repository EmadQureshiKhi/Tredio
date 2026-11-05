"use client";
import React, { useEffect, useRef } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import Image from "next/image";
import SignalLogos from "./SignalLogos";
import { SIGNAL_LOGOS } from "@/config/partners";

gsap.registerPlugin(ScrollTrigger);

/* ─── Data ─────────────────────────────────────────────────── */

const categoriesData = [
  {
    id: "01",
    category: "Topics",
    title: "Topics trend every day. Most of that attention had nowhere to go.",
    backgroundColor: "bg-[#6F61D1]",
    description:
      "When a topic gains traction, the radar picks it up, an AI review checks it, and it gets a market on Tredio. You trade the conversation itself.",
    image: "/assets/img/topics-wave.jpg",
    cta: "Start Trading",
  },
  {
    id: "02",
    category: "Attention",
    backgroundColor: "bg-[#4C4496]",
    title: "Attention has always moved prices. It never had a price of its own.",
    description:
      "Every trend has an attention index from 0 to 100, recorded every minute. Buy UP or DOWN on whether it ends a round higher, or go long or short with an attention perp.",
    image: "/assets/img/attention-eye.jpg",
    cta: "View Signals",
  },
  {
    id: "03",
    category: "Signal",
    backgroundColor: "bg-[#281F5E]",
    title: "By the time it's in the news, the interesting trade already happened.",
    description:
      "Social mentions from Elfa and Bluesky, Wikipedia pageviews, Hacker News and Nansen's smart-money flows feed one score. The Tredio oracle records it, and every market reads it.",
    image: "/assets/img/elfa-ai-logo.png",
    logos: SIGNAL_LOGOS,
    cta: "See What's Trending",
  },
  {
    id: "04",
    category: "Tokens",
    backgroundColor: "bg-[#110F28]",
    title: "A trend big enough to talk about can have a coin of its own.",
    description:
      "Trend coins launch on bonding curves and can graduate to their own pool. For the asset behind a trend, trade asset perps from the same account.",
    image: "/assets/img/token-cards.jpg",
    cta: "Find Markets",
  },
];

/* ─── Card ─────────────────────────────────────────────────── */

const SliderCard = ({
  id,
  category,
  title,
  description,
  backgroundColor,
  image,
  logos,
}) => {
  return (
    <div
      className={`flex-shrink-0 w-full origin-center h-full justify-between flex items-stretch overflow-hidden max-sm:flex-col max-sm:h-auto ${backgroundColor}`}
    >
      {/* LEFT: text */}
      <div className="w-[55%] h-[100%] flex flex-col justify-between py-[4vw] px-[2vw] max-sm:w-full max-sm:h-auto max-sm:py-[8vw] max-sm:px-[6vw]">
        <div>
          <h2 className="text-[7vw] font-third mb-[2vw] text-[#F3EFEB] max-sm:text-[14vw] max-sm:mb-[3vw]">
            {category}
          </h2>
        </div>

        <div className="flex justify-between gap-[12vw] max-sm:flex-col max-sm:gap-[4vw]">
          <div aria-hidden="true" className="text-[8vw] w-fit font-third leading-none mb-[3vw] text-[#F3EFEB]/20 select-none max-sm:text-[20vw] max-sm:mb-[1vw]">
            {id}
          </div>

          <div className="flex-grow flex flex-col justify-center space-y-[2vw]">
            <h3 className="text-[2.5vw] font-display leading-[1.2] text-[#F3EFEB] max-sm:text-[5.5vw]">
              {title}
            </h3>
            <p className="text-[1.4vw] text-white leading-[1.3] max-sm:text-[3.8vw] max-sm:leading-[1.4]">
              {description}
            </p>

          </div>
        </div>
      </div>

      {/* RIGHT: image */}
      <div className="w-[40%] h-[75%] my-auto p-[4vw] max-sm:w-full max-sm:h-auto max-sm:px-[6vw] max-sm:pt-0 max-sm:pb-[8vw] max-sm:my-0">
        <div className="h-full w-full overflow-hidden rounded-[2vw] max-sm:h-[55vw] max-sm:rounded-[4vw]">
          {logos ? (
            <SignalLogos logos={logos} className="rounded-[2vw]" />
          ) : (
            <Image
              width={800}
              height={800}
              src={image}
              alt=""
              sizes="(max-width: 640px) 90vw, 40vw"
              className="card-image w-full h-full rounded-[2vw] object-cover"
            />
          )}
        </div>
      </div>
    </div>
  );
};

/* ─── Section ──────────────────────────────────────────────── */

const Categories = () => {
  const containerRef = useRef(null);
  const cardsRef = useRef([]);

  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add("(min-width: 640px)", () => {
      const ctx = gsap.context(() => {
        const cards = cardsRef.current;
        const numCards = cards.length;

        cards.forEach((card, i) => {
          gsap.set(card, {
            yPercent: i === 0 ? 0 : 100,
            zIndex: i + 1,
            scale: 1,
            rotation: 0,
            borderRadius: 0,
          });
        });

        const firstImage = cards[0].querySelector(".card-image");
        if (firstImage) {
          gsap.fromTo(
            firstImage,
            { scale: 1.5 },
            {
              scale: 1,
              ease: "power2.out",
              scrollTrigger: {
                trigger: containerRef.current,
                start: "50% bottom",
                end: "bottom 60%",
                scrub: true,
              },
            },
            0,
          );
        }

        // The card with partner logos stays pinned for HOLD extra steps while its logos cycle, about
        // 0.3 of a step per logo tile.
        const logoCard = categoriesData.findIndex((c) => c.logos);
        const HOLD = logoCard > 0 ? 0.3 * categoriesData[logoCard].logos.length : 0;
        const at = (step) => step + (logoCard > 0 && step >= logoCard ? HOLD : 0);

        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: containerRef.current,
            start: "top top",
            end: `+=${(numCards - 1 + HOLD) * 100}%`,
            scrub: true,
          },
        });

        if (logoCard > 0) {
          const tiles = cards[logoCard].querySelectorAll(".signal-logo");
          // The card lands at `logoCard`; the next one starts covering it HOLD steps later. Change
          // tiles evenly in between, leaving the last one a full share of the hold.
          const step = (HOLD - 0.3) / (tiles.length - 1);
          for (let k = 1; k < tiles.length; k++) {
            const t = logoCard + 0.1 + (k - 1) * step;
            tl.to(tiles[k - 1], { autoAlpha: 0, duration: 0.08, ease: "none" }, t);
            tl.to(tiles[k], { autoAlpha: 1, duration: 0.08, ease: "none" }, t);
          }
        }

        for (let i = 1; i < numCards; i++) {
          const rotateDir = (i - 1) % 2 === 0 ? -5 : 5;
          const start = at(i - 1);

          tl.to(cards[i], { yPercent: 0, ease: "none" }, start);

          const currentCardImage = cards[i].querySelector(".card-image");
          if (currentCardImage) {
            tl.fromTo(
              currentCardImage,
              { scale: 1.2 },
              { scale: 1, ease: "none" },
              start + 0.5,
            );
          }

          tl.to(
            cards[i - 1],
            {
              scale: 0.8,
              rotation: rotateDir,
              rotateX: 20,
              borderRadius: "3vw",
              ease: "linear",
            },
            start,
          ).to(cards[i - 1], { opacity: 0, ease: "none" }, start + 0.5);
        }
      }, containerRef);

      return () => ctx.revert();
    });

    return () => mm.revert();
  }, []);

  return (
    <section id="markets" className="relative h-[530vh] max-sm:h-auto w-full z-0">
      <div
        ref={containerRef}
        className="sticky top-0 w-screen h-screen bg-black overflow-hidden max-sm:relative max-sm:h-auto"
        style={{ perspective: "1200px" }}
      >
        {categoriesData.map((category, i) => (
          <div
            key={category.id}
            ref={(el) => (cardsRef.current[i] = el)}
            className="absolute inset-0 overflow-hidden max-sm:static"
          >
            <SliderCard {...category} />
          </div>
        ))}
      </div>
    </section>
  );
};

export default Categories;
