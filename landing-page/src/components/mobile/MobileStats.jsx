import React from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import 'swiper/css';
import Image from 'next/image';

const statsData = [
  {
    number: "100",
    heading: "Scored 0 to 100",
    content: "Social mentions, Wikipedia pageviews and smart-money flows become one index, recorded by the Tredio oracle.",
    image: "/assets/img/attention-cat.jpg",
    alt: "An illustrated lavender cat in a hoodie trading Up and Down at a desk in a library"
  },
  {
    number: "24h",
    heading: "24-Hour and 7-Day Rounds",
    content: "Every Up/Down series asks one question: will the index close above where it opened?",
    image: "/assets/img/market-opens.webp",
    alt: "World map with clocks in several time zones"
  },
  {
    number: "1",
    heading: "Each Winning Token Pays 1 USDC",
    content: "UP and DOWN trade between 0 and 1 USDC, a dollar stablecoin. At settlement each winning token pays 1 USDC and each losing token pays nothing.",
    image: "/assets/img/rising-chart.jpg",
    alt: "A glowing line chart rising through glass panes"
  },
  {
    number: "0",
    heading: "No Gas to Pay",
    content: "Sign in with a passkey. A relayer pays the network fees, so there is no seed phrase and no extension.",
    image: "/assets/img/no-gas-cat.jpg",
    alt: "An illustrated lavender cat in a hoodie being patted on the head beside a glowing phone in a cheering stadium"
  },
  {
    number: "4",
    heading: "Four Ways to Trade",
    content: "Up/Down outcomes on an order book, attention perps, trend coins on bonding curves and asset perps.",
    image: "/assets/img/ai-thumbnails.jpg",
    alt: "A collage of market thumbnails"
  }
];

const MobileStats = () => {
  const [progress, setProgress] = React.useState(0);

  const handleSlideChange = (swiper) => {
    const progressValue = ((swiper.activeIndex + 1) / statsData.length) * 100;
    setProgress(progressValue);
  };

  return (
    <div id="insights" className="w-full bg-[#9C93E8] py-8 min-h-[80vh] mr-0 mt-20">

        <h2 className='text-[5vw] font-display mx-2 text-black'>
            Attention has a price. Now it has a market.
        </h2>
      <Swiper
        modules={[]}
        spaceBetween={16}
        slidesPerView={1.2}
        centeredSlides={false}
        onSlideChange={handleSlideChange}
        onSwiper={(swiper) => handleSlideChange(swiper)}
        className="!px-2 mt-5"
      >
        {statsData.map((stat, index) => (
          <SwiperSlide key={index} className="!h-auto">
            <div className="h-full bg-white rounded-lg overflow-hidden">
                <div className="text-[25vw] font-third text-gray-900 mb-2 h-[28vw] flex items-center leading-none overflow-hidden">
                  {stat.number}
                </div>
              {/* Image Section */}

              <div className="relative h-[23vh] w-full rounded-xl overflow-hidden">
                <Image
                  src={stat.image}
                  alt={stat.alt}
                  fill
                  sizes="85vw"
                  className="object-cover"
                />
              </div>
              
              {/* Content Section */}
              <div className="p-4">
                {/* Number */}
                
                
                {/* Heading */}
                <h3 className="text-[7vw] leading-[1.1] font-semibold text-gray-900 mb-5">
                  {stat.heading}
                </h3>
                
                {/* Description */}
                <p className="text-[4vw] font-medium leading-[1.25] text-gray-700">
                  {stat.content}
                </p>
              </div>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>

      {/* Progress Bar */}
      <div className="px-4 mt-6">
        <div className="w-full h-1 bg-gray-200 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gray-900 transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      </div>
    </div>
  );
};

export default MobileStats;