// Captures the app screens used in the promo (fake data, see mock.cjs).
// Phone screens: 390x797 CSS px (an iPhone screen below the status bar) at 4x.
const { chromium } = require('playwright')
const fs = require('fs')
const { setup, push, typing, login, ME, ADAM, ALI, MUD, GROUP, t } = require('./mock.cjs')
const OUT = __dirname + '/../public/tex'
const layout = {}
const PHONE = { viewport: { width: 390, height: 797 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true }
const settle = (page, ms = 700) => page.evaluate(() => document.fonts.ready).then(() => page.waitForTimeout(ms))
const shot = async (page, name) => { await settle(page); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('saved', name) }
const box = async (page, sel) => { const b = await page.locator(sel).last().boundingBox(); return b && { x: b.x, y: b.y, w: b.width, h: b.height } }
const rt = (state, table, record) => state.ws.send(JSON.stringify([null, null, state.chatTopic, 'postgres_changes', { data: { type: 'INSERT', schema: 'public', table, record, commit_timestamp: new Date().toISOString(), columns: [], errors: null }, ids: [] }]))

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  // ---- chat list + the live group-chat sequence ----
  {
    const page = await browser.newPage({ ...PHONE, colorScheme: 'light' })
    const st = await setup(page, { reads: [{ message_id: 109, user_id: ME, read_at: t(60) }], reactions: [{ message_id: 100, user_id: ADAM, emoji: '🔥' }, { message_id: 102, user_id: ME, emoji: '👍' }] })
    await login(page)
    await settle(page, 1200)
    typing(st, ALI, `g:${GROUP}`)
    await shot(page, 'list')
    layout.list = { rows: await page.$$eval('.convo', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { title: e.querySelector('.convo-title')?.textContent, x: r.x, y: r.y, w: r.width, h: r.height } })) }

    await page.click('.convo:has(.convo-title:text-is("Group Chat"))')
    await settle(page, 900)
    await shot(page, 'group-0')
    layout.group0 = { status: await box(page, '.read-status'), composer: await box(page, '.composer'), back: await box(page, '.glass-btn.back') }

    typing(st, ALI, null)
    await page.waitForSelector('.typing-row')
    await shot(page, 'group-1')
    layout.group1 = { typing: await box(page, '.typing-row') }

    const reply = { id: 200, user_id: ALI, recipient_id: null, group_id: null, content: 'Yes! Everything is ready 🚀', created_at: new Date().toISOString() }
    push(st, reply)
    await page.waitForSelector('.row:has-text("Everything is ready")')
    for (const u of [ALI, ADAM, MUD]) rt(st, 'message_reads', { message_id: 103, user_id: u, read_at: new Date().toISOString() })
    await settle(page, 900)
    await shot(page, 'group-2')
    layout.group2 = { reply: await box(page, '.row:has-text("Everything is ready")'), status: await box(page, '.read-status') }

    st.reactions.push({ message_id: 200, user_id: ME, emoji: '❤️' })
    st.reads.push(...[ALI, ADAM, MUD].map((u) => ({ message_id: 103, user_id: u, read_at: new Date().toISOString() })))
    rt(st, 'reactions', { message_id: 200, user_id: ME, emoji: '❤️' })
    await page.waitForSelector('.row:has-text("Everything is ready") .tapback')
    await shot(page, 'group-3')
    layout.group3 = { tapback: await box(page, '.row:has-text("Everything is ready") .tapback'), reply: await box(page, '.row:has-text("Everything is ready")') }

    await page.click('.plus-btn')
    await settle(page, 600)
    await shot(page, 'attach')
    layout.attach = { sheet: await box(page, '.attach-pop') }
    await page.click('.attach-backdrop', { position: { x: 20, y: 30 } })

    // private chat with Adam (AI): voice notes + a photo
    await page.click('.glass-btn.back')
    await settle(page, 700)
    await page.click('.convo:has-text("Here is the poster")')
    await settle(page, 1200)
    await shot(page, 'dm-adam')
    layout.dm = { photo: await box(page, 'img.media'), call: await box(page, '.glass-btn.right'), voice: await box(page, '.voice') }

    await page.click('img.media')
    await settle(page, 900)
    await shot(page, 'viewer')
    await page.evaluate(() => {
      const el = document.querySelector('.viewer-stage')
      for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: 195, clientY: 400, bubbles: true, pointerId: 9 }))
    })
    await page.waitForTimeout(500)
    await shot(page, 'viewer-chrome')
    await page.keyboard.press('Escape')
    await settle(page, 400)
    await page.close()
  }

  // ---- live call with Adam (the call screen, frozen mid-call) ----
  {
    const page = await browser.newPage({ ...PHONE, colorScheme: 'light' })
    await setup(page)
    await page.route('**/api/call/start', () => new Promise(() => {})) // stay on the call screen
    await login(page)
    await page.click('.convo:has-text("Here is the poster")')
    await settle(page, 900)
    await page.click('.glass-btn.right')
    await page.waitForSelector('.call-screen .call-name')
    await page.evaluate(() => {
      document.querySelector('.call-status').textContent = '2:14'
      const top = document.querySelector('.call-top')
      const cap = document.createElement('div')
      cap.className = 'call-caption'
      cap.textContent = 'Hey Mubarak! Ready when you are. Want me to start with the intro?'
      top.appendChild(cap)
      document.querySelector('.call-avatar')?.classList.add('speaking')
      const controls = document.querySelector('.call-controls')
      const mute = document.createElement('button')
      mute.className = 'call-btn'
      mute.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg><span>Mute</span>'
      controls.prepend(mute)
    })
    await shot(page, 'call')
    await page.close()
  }

  // ---- making a group ----
  {
    const page = await browser.newPage({ ...PHONE, colorScheme: 'light' })
    await setup(page, { withGroup: false })
    await login(page)
    await settle(page, 900)
    await shot(page, 'list-nogroup')
    await page.click('.list-new')
    await settle(page, 500)
    await shot(page, 'newgroup-0')
    await page.fill('.group-name-input', 'Launch Team')
    await page.locator('.group-name-input').blur()
    for (const name of ['adam', 'ali', 'mudassir']) await page.click(`.pick-list li:has-text("${name}") label`)
    await shot(page, 'newgroup-1')
    layout.newgroup = { sheet: await box(page, '.group-sheet'), checks: await page.$$eval('.pick-check', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })), create: await box(page, '.sheet-done') }
    await page.close()
  }

  // ---- poll, notes and search in the Launch Team group ----
  {
    const page = await browser.newPage({ ...PHONE, colorScheme: 'light' })
    const st = await setup(page)
    await login(page)
    await settle(page, 900)
    await page.fill('.list-search input', 'launch')
    await settle(page, 900)
    await shot(page, 'search')
    await page.fill('.list-search input', '')
    await page.click('.convo:has(.convo-title:text-is("Launch Team"))')
    await settle(page, 900)
    await page.click('.plus-btn')
    await page.waitForTimeout(400)
    await page.click('.attach-pop button:has-text("Polls")')
    await page.waitForTimeout(400)
    await page.fill('.poll-compose-choices input >> nth=0', 'Friday 5 PM')
    await page.fill('.poll-compose-choices input >> nth=1', 'Saturday noon')
    await page.fill('.poll-compose-choices input >> nth=2', 'Monday 9 AM')
    await page.fill('.poll-compose-send input', 'When do we launch?')
    await page.locator('.poll-compose-send input').blur()
    await shot(page, 'poll-compose')
    layout.pollCompose = { box: await box(page, '.poll-compose') }
    await page.click('.poll-compose-send .send-btn')
    await settle(page, 900)
    await shot(page, 'poll-0')
    const poll = st.t.polls[0]
    const votes = [[ADAM, 0], [ALI, 0], [MUD, 1], [ME, 0]]
    for (const [u, o] of votes) {
      st.t.poll_votes = [...(st.t.poll_votes ?? []), { poll_id: poll.id, user_id: u, option: o }]
    }
    rt(st, 'poll_votes', { poll_id: poll.id })
    await page.waitForSelector('.ipoll-option.voted', { timeout: 20000 })
    await settle(page, 900)
    await shot(page, 'poll-1')
    layout.poll = { card: await box(page, '.ipoll') }
    await page.click('.topbar-center')
    await settle(page, 500)
    await page.click('.info-tools button:has-text("Notes")')
    await settle(page, 500)
    await page.fill('.tool-add-row input', 'Send the press kit')
    await page.click('.tool-add-row button')
    await page.fill('.tool-add-row input', 'Record the intro video')
    await page.click('.tool-add-row button')
    await page.waitForTimeout(400)
    await page.click('.segmented button:has-text("Decisions")')
    await page.fill('.tool-add-row input', 'We launch Friday at 5 PM')
    await page.click('.tool-add-row button')
    await page.waitForTimeout(400)
    await page.locator('.tool-add-row input').blur()
    await shot(page, 'notes')
    await page.close()
  }

  // ---- dark mode list ----
  {
    const page = await browser.newPage({ ...PHONE, colorScheme: 'dark' })
    const st = await setup(page)
    await login(page)
    await settle(page, 1200)
    typing(st, ALI, `g:${GROUP}`)
    await shot(page, 'list-dark')
    await page.close()
  }

  // ---- desktop: list beside the chat ----
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' })
    await setup(page, { reactions: [{ message_id: 100, user_id: ADAM, emoji: '🔥' }] })
    await login(page)
    await page.click('.convo:has(.convo-title:text-is("Group Chat"))')
    await settle(page, 1200)
    await page.mouse.move(1, 999)
    await shot(page, 'desktop')
    await page.close()
  }

  fs.writeFileSync(`${OUT}/layout.json`, JSON.stringify(layout, null, 2))
  await browser.close()
})()
