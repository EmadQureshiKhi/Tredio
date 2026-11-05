"use client";
import React, { useEffect, useRef } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import Image from "next/image";
import { TRACKS } from "@/config/content";

gsap.registerPlugin(ScrollTrigger);

/* ─── Card ─────────────────────────────────────────────────── */

const TrackCard = ({ id, name, title, description, background, image, alt }) => {
  return (
    <div
      className={`flex-shrink-0 w-full origin-center h-full justify-between flex items-stretch overflow-hidden max-sm:flex-col max-sm:h-auto ${background}`}
    >
      {/* LEFT: text */}
      <div className="w-[55%] h-[100%] flex flex-col justify-between py-[4vw] px-[2vw] max-sm:w-full max-sm:h-auto max-sm:py-[8vw] max-sm:px-[6vw]">
        <div>
          <p className="font-body text-[clamp(10px,0.8vw,14px)] font-semibold uppercase tracking-[0.18em] text-[#F3EFEB]/70 mb-[0.6vw]">
            Track {id}
          </p>
          <h2 className="text-[6vw] font-third leading-[1] tracking-[-0.02em] text-[#F3EFEB] max-sm:text-[14vw]">
            {name}
          </h2>
        </div>

        <div className="flex justify-between gap-[10vw] max-sm:flex-col max-sm:gap-[4vw]">
          <div aria-hidden="true" className="text-[8vw] w-fit font-third leading-none mb-[3vw] text-[#F3EFEB]/20 select-none max-sm:text-[20vw] max-sm:mb-[1vw]">
            {id}
          </div>

          <div className="flex-grow flex flex-col justify-center space-y-[1.6vw]">
            <h3 className="text-[2.5vw] font-display leading-[1.15] text-[#F3EFEB] max-sm:text-[5.5vw]">
              {title}
            </h3>
            <p className="text-[1.25vw] text-white/90 leading-[1.45] max-sm:text-[3.8vw] max-sm:leading-[1.4]">
              {description}
            </p>
          </div>
        </div>
      </div>

      {/* RIGHT: picture */}
      <div className="w-[40%] h-[75%] my-auto p-[4vw] max-sm:w-full max-sm:h-auto max-sm:px-[6vw] max-sm:pt-0 max-sm:pb-[8vw] max-sm:my-0">
        <div className="h-full w-full overflow-hidden rounded-[2vw] max-sm:h-[55vw] max-sm:rounded-[4vw]">
          <Image
            width={1200}
            height={1200}
            src={image}
            alt={alt}
            sizes="(max-width: 640px) 90vw, 40vw"
            className="card-image w-full h-full rounded-[2vw] object-cover"
          />
        </div>
      </div>
    </div>
  );
};

/* ─── Section ──────────────────────────────────────────────── */

// The four tracks as stacked cards: each new card slides up over the last while the page is pinned.
const Tracks = () => {
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

        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: containerRef.current,
            start: "top top",
            end: `+=${(numCards - 1) * 100}%`,
            scrub: true,
          },
        });

        for (let i = 1; i < numCards; i++) {
          const rotateDir = (i - 1) % 2 === 0 ? -5 : 5;
          const start = i - 1;

          tl.to(cards[i], { yPercent: 0, ease: "none" }, start);

          const currentCardImage = cards[i].querySelector(".card-image");
          if (currentCardImage) {
            tl.fromTo(currentCardImage, { scale: 1.2 }, { scale: 1, ease: "none" }, start + 0.5);
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
    <section id="tracks" aria-label="Tracks" className="relative h-[400vh] max-sm:h-auto w-full z-0">
      <div
        ref={containerRef}
        className="sticky top-0 w-screen h-screen bg-black overflow-hidden max-sm:relative max-sm:h-auto"
        style={{ perspective: "1200px" }}
      >
        {TRACKS.map((track, i) => (
          <div
            key={track.id}
            ref={(el) => (cardsRef.current[i] = el)}
            className="absolute inset-0 overflow-hidden max-sm:static"
          >
            <TrackCard {...track} />
          </div>
        ))}
      </div>
    </section>
  );
};

export default Tracks;
