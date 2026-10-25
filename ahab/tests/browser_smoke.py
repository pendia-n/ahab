"""Local browser smoke test. Uses disposable local accounts; never calls paid APIs."""
import os
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('AHAB_TEST_URL', 'http://localhost:4321')
assert BASE.startswith('http://localhost:'), 'This test creates disposable accounts only on localhost.'
ROOT = Path(__file__).resolve().parents[1]
username = 'ahab_smoke_' + str(int(time.time()))
password = 'PreviewOnly123'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    assert 'Ahab' in page.title()
    page.screenshot(path='/tmp/ahab-desktop.png', full_page=True)
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
    page.goto(BASE + '/studio')
    expect(page).to_have_url(BASE + '/signin?next=%2Fstudio')
    page.goto(BASE + '/signup')
    page.locator('[name=username]').fill(username)
    page.locator('[name=password]').fill(password)
    page.locator('[name=passcode]').fill('demo1234')
    page.locator('input[type=checkbox]').check()
    page.locator('button[type=submit]').click()
    expect(page).to_have_url(BASE + '/studio', timeout=20000)
    page.wait_for_load_state('networkidle')
    assert page.locator('#generate-button').is_disabled()
    cookie = next(c for c in context.cookies() if c['name'] == '__Host-ahab')
    assert cookie['httpOnly'] and cookie['secure'] and cookie['sameSite'] == 'Lax'
    assert 269 * 86400 < cookie['expires'] - time.time() <= 270 * 86400
    page.locator('[data-upload=image]').set_input_files(str(ROOT / 'public/apple-touch-icon.png'))
    expect(page.locator('#upload-status')).to_contain_text('Saved to your library', timeout=20000)
    page.locator('#prompt').fill('A friendly explanation with a calm, natural delivery.')
    page.locator('#save-prompt').click()
    expect(page.locator('.toast')).to_contain_text('Prompt saved')
    for width, height, name in [(1440,1000,'desktop'),(850,1000,'tablet'),(390,844,'mobile')]:
        page.set_viewport_size({'width':width,'height':height})
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), name + ' overflow'
        page.screenshot(path='/tmp/ahab-studio-' + name + '.png', full_page=True)
    page.goto(BASE + '/library')
    page.wait_for_load_state('networkidle')
    page.locator('[data-filter=image]').click()
    expect(page.locator('.asset-card')).to_have_count(1)
    page.locator('[data-filter=prompts]').click()
    expect(page.locator('.prompt-card')).to_have_count(1)
    result = page.evaluate("""async () => {
      const library=await (await fetch('/api/library')).json();
      const id=library.assets[0].id;
      const range=await fetch('/api/media/'+id,{headers:{Range:'bytes=0-9'}});
      const csrf=await fetch('/api/prompts',{method:'POST',body:JSON.stringify({text:'blocked'})});
      return {range:range.status,length:(await range.arrayBuffer()).byteLength,csrf:csrf.status};
    }""")
    assert result == {'range':206,'length':10,'csrf':403}, result
    page.locator('[data-filter=prompts]').click()
    page.locator('[data-delete-prompt]').click()
    expect(page.locator('.prompt-card')).to_have_count(0)
    page.locator('[data-filter=image]').click()
    page.locator('[data-delete-asset]').click()
    expect(page.locator('.asset-card')).to_have_count(0)
    page.goto(BASE + '/purchases')
    page.wait_for_load_state('networkidle')
    assert page.locator('[data-checkout]:not([disabled])').count() == 0
    page.goto(BASE + '/profile')
    page.locator('[data-logout]').first.click()
    expect(page).to_have_url(BASE + '/signin')
    page.goto(BASE + '/recovery')
    page.locator('[name=username]').fill(username)
    page.locator('[name=passcode]').fill('demo1234')
    page.locator('#recovery-verify button[type=submit]').click()
    expect(page.locator('#recovery-reset')).to_be_visible()
    page.locator('#recovery-reset [name=password]').fill('AnotherPreview123')
    page.locator('#recovery-reset button[type=submit]').click()
    expect(page).to_have_url(BASE + '/signin', timeout=10000)
    page.locator('[name=username]').fill(username)
    page.locator('[name=password]').fill('AnotherPreview123')
    page.locator('button[type=submit]').click()
    expect(page).to_have_url(BASE + '/studio')
    page.evaluate('navigator.serviceWorker.ready.then(() => true)')
    context.set_offline(True)
    page.goto(BASE + '/library')
    expect(page.get_by_role('heading', level=1)).to_contain_text('needs a connection')
    context.set_offline(False)
    assert not errors, errors
    print('Browser smoke passed: responsive UI, signup, private upload, prompt history, seeking, CSRF, deletion, disabled checkout, recovery, and offline screen.')
    print('Disposable local account: ' + username)
    browser.close()
