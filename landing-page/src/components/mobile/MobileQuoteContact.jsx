import Image from 'next/image'
import React from 'react'
import { APP_URL } from '@/config/links'

const MobileQuoteContact = () => {
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
        <p className='font-third text-[#9C93E8] text-[15vw] relative'>
          LAUNCH
          <span className='absolute z-15 bottom-2 left-0 w-[42vw] bg-[#9C93E8] h-[1px]' />
        </p>

        <h2 className='font-third text-white text-[6.5vw] text-center leading-[1.2]'>
          Ready to launch and trade?
        </h2>

        <p className='text-white/80 text-[4vw] text-center leading-[1.5]'>
          Something is trending right now. Sign in with a passkey and trade it on Testnet, gas-free.
        </p>

        <a
          href={APP_URL}
          target='_blank'
          rel='noopener noreferrer'
          className='mt-2 bg-[#9C93E8] text-black font-semibold font-display uppercase text-[3.5vw] tracking-widest px-[8vw] py-[4vw] rounded-full'
        >
          Launch App
        </a>
      </div>
    </section>
  )
}

export default MobileQuoteContact
