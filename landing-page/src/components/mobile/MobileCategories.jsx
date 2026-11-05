import React from 'react';
import Image from 'next/image';
import SignalLogos from '../home/SignalLogos';
import { SIGNAL_LOGOS } from '@/config/partners';

const categoriesData = [
  {
    id: "01",
    category: "Topics",
    title: "Topics trend every day. Most of that attention had nowhere to go.",
    backgroundColor: "bg-[#6F61D1]",
    textColor: "text-[#F3EFEB]",
    description:
      "When a topic gains traction, the radar picks it up, an AI review checks it, and it gets a market on Tredio. You trade the conversation itself.",
    image: "/assets/img/topics-wave.jpg",
    cta: "Start Trading",
  },
  {
    id: "02",
    category: "Attention",
    backgroundColor: "bg-[#4C4496]",
    textColor: "text-[#F3EFEB]",
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
    textColor: "text-[#F3EFEB]",
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
    textColor: "text-[#F3EFEB]",
    title: "A trend big enough to talk about can have a coin of its own.",
    description:
      "Trend coins launch on bonding curves and can graduate to their own pool. For the asset behind a trend, trade asset perps from the same account.",
    image: "/assets/img/token-cards.jpg",
    cta: "Find Markets",
  },
];

const MobileCategories = () => {
  return (
    <div id="markets" className="flex flex-col">
      {categoriesData.map((item) => (
        <div
          key={item.id}
          className={`${item.backgroundColor} min-h-screen flex flex-col px-6 py-8`}
        >
          {/* Header */}
          <div className="mb-10">
            <h2 className={`text-6xl font-third ${item.textColor} mb-4`}>{item.category}</h2>
            <div className="flex items-start justify-between gap-4">
              <span aria-hidden="true" className={`text-5xl ${item.textColor} opacity-20 w-[20%] font-third`}>{item.id}</span>
              <p className={`text-2xl font-display pt-2 w-[73%] leading-[1.2] ${item.textColor}`}>
                {item.title}
              </p>
            </div>
          </div>

          {/* Image */}
          <div className="flex items-start justify-end mb-10">
            <div className="w-[75%]">
              {item.logos ? (
                <div className="h-64 rounded-2xl overflow-hidden shadow-lg">
                  <SignalLogos logos={item.logos} selfScroll />
                </div>
              ) : (
                <Image
                  src={item.image}
                  alt=""
                  width={600}
                  height={400}
                  sizes="75vw"
                  className="w-full h-64 object-cover rounded-2xl shadow-lg"
                />
              )}
            </div>
          </div>

          {/* Description */}
          <p className="text-lg leading-[1.4] mb-10 max-w-md text-white">
            {item.description}
          </p>


        </div>
      ))}
    </div>
  );
};

export default MobileCategories;