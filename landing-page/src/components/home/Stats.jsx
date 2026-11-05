"use client";
import React, { useRef, useEffect } from "react";
import Image from "next/image";
import gsap from "gsap";
import ScrollTrigger from "gsap/dist/ScrollTrigger";
import Btn from "../button/Btn";

gsap.registerPlugin(ScrollTrigger);

const Insights = () => {
  const imageRefs = useRef([]);
  const imageWrapperRef = useRef(null);
  const containerRef = useRef(null);
  const headingRefs = useRef([]);
  const contentRefs = useRef([]);

  const baseRotateX = 5;
  const baseRotateY = -5;

const mids = [
  {
    no: '100',
    superScript: ''
  },
  {
    no: '24',
    superScript: 'h'
  },
  {
    no: '1',
    superScript: ''
  },
  {
    no: '0',
    superScript: ''
  },
  {
    no: '4',
    superScript: ''
  },
];

  const heading = [
    "Attention, Scored 0 to 100",
    "24-Hour and 7-Day Rounds",
    "Each Winning Token Pays 1 USDC",
    "No Gas to Pay",
    "Four Ways to Trade",
  ];

  const content = [
    "Social mentions, Wikipedia pageviews and smart-money flows become one index, recorded by the Tredio oracle.",
    "Every Up/Down series asks one question: will the index close above where it opened?",
    "UP and DOWN trade between 0 and 1 USDC, a dollar stablecoin. At settlement each winning token pays 1 USDC and each losing token pays nothing.",
    "Sign in with a passkey. A relayer pays the network fees, so there is no seed phrase and no extension.",
    "Up/Down outcomes on an order book, attention perps, trend coins on bonding curves and asset perps.",
  ];

  const imageSources = [
    "/assets/img/attention-cat.jpg",
    "/assets/img/market-opens.webp",
    "/assets/img/rising-chart.jpg",
    "/assets/img/no-gas-cat.jpg",
    "/assets/img/ai-thumbnails.jpg",
  ];

  const imageAlts = [
    "An illustrated lavender cat in a hoodie trading Up and Down at a desk in a library",
    "World map with clocks in several time zones",
    "A glowing line chart rising through glass panes",
    "An illustrated lavender cat in a hoodie being patted on the head beside a glowing phone in a cheering stadium",
    "A collage of market thumbnails",
  ];

  useEffect(() => {
    const ctx = gsap.context(() => {
      const total = heading.length;

      heading.forEach((_, i) => {
        const startPos = (i / total) * 70;
        const endPos = startPos + 13.8;

        if (!headingRefs.current[i] || !contentRefs.current[i]) return;

        gsap.set([headingRefs.current[i], contentRefs.current[i]], { y: "8vw", opacity: 0 });
        if (i === 0) gsap.set([headingRefs.current[i], contentRefs.current[i]], { y: 0, opacity: 1 });

        ScrollTrigger.create({
          trigger: "#insights",
          start: `${startPos}% 20.5%`,
          end: `${endPos}% 20.5%`,

          onEnter: () => {
            if (!headingRefs.current[i] || !contentRefs.current[i]) return;
            if (i > 0) {
              gsap.fromTo(
                [headingRefs.current[i], contentRefs.current[i]],
                { y: "8vw",opacity:0},
                { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" }
              );

              // IMAGE CROSSFADE
              if (imageRefs.current[i - 1]) {
                gsap.to(imageRefs.current[i - 1], {
                  opacity: 0,
                  duration: 0.2,
                  ease: "power2.out",
                });
              }
              if (imageRefs.current[i]) {
                gsap.to(imageRefs.current[i], {
                  opacity: 1,
                  duration: 0.2,
                  ease: "power2.out",
                });
              }
            }
          },

          // === ON LEAVE DOWN (scroll continues) ===
          onLeave: () => {
            if (!headingRefs.current[i] || !contentRefs.current[i]) return;
            if (i < total - 1) {
              gsap.to([headingRefs.current[i], contentRefs.current[i]], {
                y: "-8vw",
                opacity: 0,
                duration: 0.5,
                ease: "power2.out",
              });
            }
          },

          // === ON ENTER BACK (scrolling up) ===
          onEnterBack: () => {
            if (!headingRefs.current[i] || !contentRefs.current[i]) return;
            if(i===total-1)
                return;
            gsap.fromTo(
              [headingRefs.current[i], contentRefs.current[i]],
              { y: "-8vw", opacity:0},
              { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" }
            );

            // IMAGE CROSSFADE (scrolling up)
            
            if (imageRefs.current[i + 1]) {
              gsap.to(imageRefs.current[i + 1], {
                opacity: 0,
                duration: 0.2,
                ease: "power2.out",
              });
            }
            if (imageRefs.current[i]) {
              gsap.to(imageRefs.current[i], {
                opacity: 1,
                duration: 0.2,
                ease: "power2.out",
              });
            }
          },

          // === ON LEAVE BACK (scroll up past item) ===
          onLeaveBack: () => {
            if (!headingRefs.current[i] || !contentRefs.current[i]) return;
            if (i > 0) {
              gsap.to([headingRefs.current[i], contentRefs.current[i]], {
                y: "8vw",
                opacity: 0,
                duration: 0.5,
                ease: "power2.out",
              });
            }
          },
        });
      });

      // The white column scrolls with the page but its numbers are spaced in vw, while the items above
      // change at fixed fractions of the section's height, so on its own the column drifts out of step
      // with them as the screen's shape changes. Shift it as the page scrolls so that number i is
      // centred behind the card at the middle of item i's window, on every screen.
      const column = document.querySelector(".mid-nos");
      const columnNumbers = gsap.utils.toArray(".mid-nos p");
      if (column && columnNumbers.length === total) {
        const section = document.querySelector("#insights");
        const middleOf = (i) => {
          const r = section.getBoundingClientRect();
          return r.top + window.scrollY + ((i / total) * 70 + 6.9) / 100 * r.height - 0.205 * window.innerHeight;
        };
        const shiftAt = (i) => {
          const r = columnNumbers[i].getBoundingClientRect();
          const centre = r.top + window.scrollY + r.height / 2 - gsap.getProperty(column, "y");
          return window.innerHeight / 2 + middleOf(i) - centre;
        };
        gsap.fromTo(
          column,
          { y: () => shiftAt(0) },
          {
            y: () => shiftAt(total - 1),
            ease: "none",
            scrollTrigger: { start: () => middleOf(0), end: () => middleOf(total - 1), scrub: true, invalidateOnRefresh: true },
          }
        );
      }

      imageSources.forEach((_, i) => {
        const midNosElements = document.querySelectorAll(".mid-nos p");
        const midNosTopElements = document.querySelectorAll(".mid-nos-top p");
        if (!midNosElements[i] || !midNosTopElements[i]) return;

        gsap.set(midNosTopElements[i], { y: "20vw" });
        if (i === 0) gsap.set(midNosTopElements[i], { y: 0, opacity: 1 });

        // While a number shows on the card, its white twin sits behind the card; hide the twin so its
        // edge cannot peek out around the card.
        const hideBehindCard = (hidden) =>
          gsap.to(midNosElements[i], { opacity: hidden ? 0 : 1, duration: 0.3, ease: "power2.out", overwrite: "auto" });

        // Same window as the heading, text and picture of item i, so all four always change together.
        const startPos = (i / total) * 70;
        ScrollTrigger.create({
          trigger: "#insights",
          start: `${startPos}% 20.5%`,
          end: `${startPos + 13.8}% 20.5%`,

          onEnter: () => {
            hideBehindCard(true);
            if (i > 0) {
              gsap.fromTo(
                midNosTopElements[i],
                { y: "20vw" },
                { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" }
              );
            }
          },

          onLeave: () => {
            if (i < total - 1) {
              hideBehindCard(false);
              gsap.to(midNosTopElements[i], {
                y: "-20vw",
                duration: 0.5,
                ease: "power2.out",
              });
            }
          },

          onEnterBack: () => {
            hideBehindCard(true);
            if(i===total-1)
                return;
            gsap.fromTo(
              midNosTopElements[i],
              { y: "-20vw" },
              { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" }
            );
          },

          onLeaveBack: () => {
            hideBehindCard(false);
            if (i > 0) {
              gsap.to(midNosTopElements[i], {
                y: "20vw",
                duration: 0.5,
                ease: "power2.out",
              });
            }
          },
        });
      });
    });

    return () => ctx.revert();
  }, []);

  const handleMouseMove = (e) => {
    const container = containerRef.current;
    const image = imageWrapperRef.current;
    if (!container || !image) return;

    const { left, top, width, height } = container.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;

    const normX = (x - width / 2) / (width / 2);
    const normY = (y - height / 2) / (height / 2);

    const rotateY = baseRotateY + normX * 5;
    const rotateX = baseRotateX - normY * 5;

    gsap.to(image, {
      rotateX,
      rotateY,
      duration: 0.4,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  const handleMouseLeave = () => {
    const image = imageWrapperRef.current;
    if (!image) return;

    gsap.to(image, {
      rotateX: baseRotateX,
      rotateY: baseRotateY,
      duration: 0.6,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  return (
    <section
      id="insights"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="w-screen h-[190vh] bg-[#9C93E8] relative z-55"
    >
      <div className="h-screen w-full overflow-hidden sticky top-0 flex items-center justify-between px-[5vw] z-2">

        <div
          ref={imageWrapperRef}
          className="w-[33vw] bg-black h-[22vw] absolute z-2 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[1vw] overflow-hidden shadow-2xl"
          style={{
            transformStyle: "preserve-3d",
            transform: `perspective(800px) rotateX(${baseRotateX}deg) rotateY(${baseRotateY}deg)`,
          }}
        >
          {imageSources.map((src, i) => (
            <Image
              key={i}
              ref={(el) => (imageRefs.current[i] = el)}
              src={src}
              width={1000}
              height={1000}
              alt={imageAlts[i]}
              sizes="33vw"
              className="w-full h-full object-cover absolute top-0 left-0 transition-opacity duration-500"
              style={{ opacity: i === 0 ? 1 : 0 }}
            />
          ))}
        </div>

        <div className="w-[22%]">
          <div className="h-[9vw] relative overflow-hidden w-full">
            {heading.map((no, idx) => (
              <p
                key={idx}
                ref={(el) => (headingRefs.current[idx] = el)}
                className="text-black text-[2vw] opacity-0 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 leading-[1.2] font-bold text-center w-full"
              >
                {no}
              </p>
            ))}
          </div>
        </div>

        <div className="w-[22%]">
          <div className="h-[9vw]  relative overflow-hidden w-full">
            {content.map((no, idx) => (
              <p
                key={idx}
                ref={(el) => (contentRefs.current[idx] = el)}
                className="text-black w-full text-[1.3vw] opacity-0 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 leading-[1.2] font-medium text-center"
              >
                {no}
              </p>
            ))}
          </div>
        </div>

        <div className="h-[15vw] w-[30vw] overflow-hidden absolute z-4 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-full  w-full relative space-y-[1vw] mid-nos-top">
            {mids.map((n, idx) => (
              <p
  key={idx}
  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 text-[#9C93E8] text-[10vw] font-bold whitespace-nowrap"
>
  {n.no}<span className="text-[5vw] align-super ml-[0.3vw]">{n.superScript}</span>
</p>

            ))}
          </div>
        </div>
      </div>

      <div className="w-full h-full absolute top-0 flex justify-center">
        <div className="w-[30%] h-full pt-[10vw] space-y-[5vw]">
          <div>
            <h2 className="text-[2vw] font-display text-black">
              Attention has a price. Now it has a market.
            </h2>
          </div>

          <div className="h-[15vw] w-full flex justify-center">
            <div aria-hidden="true" className="h-[55vw]  space-y-[2vw] mid-nos">
              {mids.map((n, idx) => (
                <p
                  key={idx}
                  className="text-white relative h-[12vw] text-[10vw] font-bold text-center"
                >
                     <span className="absolute text-white right-[-3vw] top-[1vw] text-[5vw]">
    {n.superScript}
  </span>
                  {n.no}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Insights;
