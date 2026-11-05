import React from "react";
import Image from "next/image";
import { TRACKS } from "@/config/content";

// The four tracks on phones: one full-height panel each.
const MobileTracks = () => {
  return (
    <section id="tracks" aria-label="Tracks" className="flex flex-col">
      {TRACKS.map((track) => (
        <div key={track.id} className={`${track.background} min-h-screen flex flex-col px-6 py-10`}>
          <div className="mb-10">
            <p className="font-body text-[12px] font-semibold uppercase tracking-[0.18em] text-[#F3EFEB]/70 mb-2">
              Track {track.id}
            </p>
            <h2 className="text-[clamp(44px,12vw,72px)] leading-[1] tracking-[-0.02em] font-third text-[#F3EFEB] mb-6">{track.name}</h2>
            <div className="flex items-start justify-between gap-4">
              <span aria-hidden="true" className="text-5xl text-[#F3EFEB] opacity-20 w-[20%] font-third leading-none">
                {track.id}
              </span>
              <p className="text-2xl font-display w-[76%] leading-[1.2] text-[#F3EFEB]">{track.title}</p>
            </div>
          </div>

          <div className="mb-10">
            <Image
              src={track.image}
              alt={track.alt}
              width={1200}
              height={1200}
              sizes="88vw"
              className="w-full aspect-[4/3] object-cover rounded-2xl shadow-lg"
            />
          </div>

          <p className="text-[17px] leading-[1.5] max-w-md text-white/90">{track.description}</p>
        </div>
      ))}
    </section>
  );
};

export default MobileTracks;
