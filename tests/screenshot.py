import asyncio, sys
from playwright.async_api import async_playwright
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP=os.path.join(ROOT,'tests','shots')+'/'
os.makedirs(SP, exist_ok=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
        errs=[]
        pg.on('console', lambda m: errs.append(m.type+': '+m.text) if m.type in ('error','warning') else None)
        pg.on('pageerror', lambda e: errs.append('pageerror: '+str(e)))
        await pg.goto('file://'+os.path.join(ROOT,'dist','index.html'))
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=SP+'s1_start.png', full_page=True)
        await pg.click('#btn-demo')
        got_fb = 0; got_live = 0
        for i in range(200):
            await pg.wait_for_timeout(250)
            fr = await pg.evaluate("getComputedStyle(document.getElementById('stage')).getPropertyValue('--fill')")
            pulse = await pg.evaluate("document.getElementById('stage').classList.contains('pulse')")
            if 'color-mix' in fr and got_fb < 2:
                got_fb += 1; await pg.screenshot(path=SP+f's2_feedback{got_fb}.png')
            if pulse and not got_live:
                got_live = 1; await pg.screenshot(path=SP+'s3_shiftnow.png')
            if got_fb >= 2 and got_live and i > 120: break
        await pg.click('#btn-stop')
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=SP+'s4_summary.png', full_page=True)
        await pg.click('.mosaic .tile')
        await pg.wait_for_timeout(300)
        n = await pg.evaluate("document.querySelectorAll('.mosaic .tile').length")
        await pg.click('#tab-settings'); await pg.wait_for_timeout(300)
        await pg.screenshot(path=SP+'s5_settings.png', full_page=True)
        print('tiles', n, 'feedback shots', got_fb, 'shiftnow', got_live)
        print('\n'.join(errs[:20]))
        await b.close()
asyncio.run(main())
