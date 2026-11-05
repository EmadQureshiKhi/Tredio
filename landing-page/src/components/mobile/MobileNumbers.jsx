import React from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import 'swiper/css';
import Image from 'next/image';
import { NUMBERS } from '@/config/content';

const statsData = NUMBERS.map((n) => ({ ...n, number: `${n.number}${n.sup ?? ""}` }));

const MobileNumbers = () => {
  const [progress, setProgress] = React.useState(0);

  const handleSlideChange = (swiper) => {
    const progressValue = ((swiper.activeIndex + 1) / statsData.length) * 100;
    setProgress(progressValue);
  };

  return (
    <section id="numbers" aria-label="Tredio in numbers" className="w-full bg-[#9C93E8] py-10 min-h-[80vh]">
      <h2 className="text-[clamp(26px,7vw,40px)] leading-[1.15] font-display mx-4 text-black">
        Attention has a price. Now it has a market.
      </h2>
      <Swiper
        modules={[]}
        spaceBetween={16}
        slidesPerView={1.2}
        centeredSlides={false}
        onSlideChange={handleSlideChange}
        onSwiper={(swiper) => handleSlideChange(swiper)}
        className="!px-4 mt-6"
      >
        {statsData.map((stat, index) => (
          <SwiperSlide key={index} className="!h-auto">
            <div className="h-full bg-white rounded-xl overflow-hidden">
              <div aria-hidden="true" className="px-4 pt-3 text-[clamp(64px,22vw,120px)] font-third tracking-[-0.03em] text-gray-900 h-[clamp(80px,26vw,140px)] flex items-center leading-none overflow-hidden">
                {stat.number}
              </div>
              <div className="relative h-[23vh] w-full overflow-hidden">
                <Image src={stat.image} alt={stat.alt} fill sizes="85vw" className="object-cover" />
              </div>
              <div className="p-4 pb-5">
                <h3 className="text-balance text-[clamp(22px,6.4vw,32px)] leading-[1.12] font-semibold text-gray-900 mb-3">{stat.heading}</h3>
                <p className="text-[clamp(15px,4vw,19px)] leading-[1.45] text-gray-700">{stat.content}</p>
              </div>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>

      {/* Progress Bar */}
      <div className="px-4 mt-6">
        <div className="w-full h-1 bg-black/15 rounded-full overflow-hidden">
          <div className="h-full bg-gray-900 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </section>
  );
};

export default MobileNumbers;