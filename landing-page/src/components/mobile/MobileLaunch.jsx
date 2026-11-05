import Image from 'next/image'
import React from 'react'
import { APP_URL } from '@/config/links'

const MobileLaunch = () => {
  return (
    <section className='relative h-screen w-full overflow-hidden'>
      <Image
        src='/assets/img/launch-thumbnails.jpg'
        height={1000}
        width={1000}
        alt=''
        className='h-full w-full object-cover blur-[8px] scale-105'
      />
      {/* Gradient overlay: spotlight effect for the center text */}
      <div className='absolute inset-0 bg-gradient-to-b from-black/20 via-black/55 to-black/20 z-[5]' />
      <div className='absolute top-0 z-10 w-full h-screen flex items-center flex-col justify-center gap-8 px-[8vw]'>
        <p aria-hidden='true' className='font-third text-[#9C93E8] text-[clamp(56px,15vw,110px)] leading-none relative pb-3'>
          LAUNCH
          <span className='absolute bottom-0 left-0 w-1/2 bg-[#9C93E8] h-px' />
        </p>

        <h2 className='font-third text-white text-[clamp(28px,7.5vw,44px)] text-center leading-[1.15]'>
          Ready to trade the feed?
        </h2>

        <p className='text-white/80 text-[clamp(15px,4.2vw,20px)] text-center leading-[1.5] max-w-[520px]'>
          Something is trending right now. Sign in with Face ID and trade it on NEAR testnet, <span className="whitespace-nowrap">gas-free.</span>
        </p>

        <a
          href={APP_URL}
          target='_blank'
          rel='noopener noreferrer'
          className='mt-2 inline-flex h-12 items-center bg-[#9C93E8] text-black font-semibold font-body uppercase text-[13px] tracking-[0.14em] px-8 rounded-full'
        >
          Launch App
        </a>
      </div>
    </section>
  )
}

export default MobileLaunch
