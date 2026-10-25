"""Session navigation regression. Creates no purchases and calls no AI models."""
import os,secrets,re
from urllib.parse import urlparse
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
BASE=os.environ.get('AHAB_TEST_URL','http://localhost:4321').rstrip('/')
assert BASE.startswith('http://localhost:') or BASE=='https://ahab.pendia-community.workers.dev'
username='nav_check_'+secrets.token_hex(4)
public=['/','/pricing','/about','/announcements','/privacy','/terms']
private=['/studio','/library','/purchases','/profile','/security']
auth=['/signin','/signup','/recovery','/signin/','/signup/','/recovery/']
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 ctx=b.new_context(viewport={'width':1440,'height':1000})
 page=ctx.new_page()
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE+'/');page.wait_for_load_state('networkidle')
 expect(page.locator('a[href="/signin"]')).to_have_count(1)
 guest_tab=ctx.new_page();guest_tab.goto(BASE+'/about');guest_tab.wait_for_load_state('networkidle')
 for path in ['/signin','/signup','/recovery']:
  response=page.request.get(BASE+path,max_redirects=0);assert response.status==200,(path,response.status)
 for path in private:
  response=page.request.get(BASE+path,max_redirects=0);assert response.status in [302,303],(path,response.status)
  assert response.headers.get('location','').startswith('/signin?next=')
 response=page.request.post(BASE+'/api/auth/signup',data={'username':username,'password':'TestOnly'+secrets.token_hex(4)+'7'},headers={'Origin':BASE,'X-Ahab-Request':'1'})
 assert response.status==200,'Disposable signup failed'
 Path('/tmp/ahab-navigation-check-user').write_text(username)
 # A tab opened before login must refresh when it regains focus.
 guest_tab.bring_to_front()
 guest_tab.evaluate("window.dispatchEvent(new Event('focus'))")
 expect(guest_tab.locator('body')).to_have_attribute('data-session-state','authenticated',timeout=15000)
 expect(guest_tab.locator('a[href="/signin"],a[href="/signup"]')).to_have_count(0)
 page.bring_to_front()
 for path in public+private:
  response=page.goto(BASE+path);page.wait_for_load_state('networkidle')
  assert response.status==200,(path,response.status)
  expect(page.locator('body')).to_have_attribute('data-session-state','authenticated')
  expect(page.locator('a[href^="/signin"],a[href^="/signup"]')).to_have_count(0)
  assert 'no-store' in response.headers.get('cache-control',''),path
  assert 'Cookie' in response.headers.get('vary',''),path
 for path in auth:
  response=page.request.get(BASE+path,max_redirects=0)
  assert response.status in [301,302,303,307,308],(path,response.status)
  if response.headers.get('location')!='/studio':
   response=page.request.get(BASE+response.headers['location'],max_redirects=0)
  assert response.headers.get('location')=='/studio',path
  page.goto(BASE+path);expect(page).to_have_url(BASE+'/studio')
  expect(page.locator('form[data-auth]')).to_have_count(0)
 # All public headers/CTAs are also correct in the mobile layout.
 page.set_viewport_size({'width':390,'height':844})
 for path in public:
  page.goto(BASE+path);page.wait_for_load_state('networkidle')
  expect(page.locator('a[href^="/signin"],a[href^="/signup"]')).to_have_count(0)
 page.goto(BASE+'/');page.screenshot(path='/tmp/ahab-signed-in-mobile.png',full_page=True)
 page.goto(BASE+'/offline');page.wait_for_load_state('networkidle')
 expect(page.locator('a[href^="/signin"],a[href^="/signup"]')).to_have_count(0)
 page.evaluate('navigator.serviceWorker.ready.then(()=>true)')
 page.reload();page.wait_for_load_state('networkidle')
 ctx.set_offline(True);page.goto(BASE+'/library')
 expect(page.get_by_role('heading',level=1)).to_contain_text('needs a connection')
 expect(page.locator('a[href^="/signin"],a[href^="/signup"]')).to_have_count(0)
 ctx.set_offline(False)
 # Logging out must remove access and refresh another tab's old signed-in header.
 response=page.request.post(BASE+'/api/auth/logout',data={},headers={'Origin':BASE,'X-Ahab-Request':'1'})
 assert response.status==200
 guest_tab.bring_to_front();guest_tab.evaluate("window.dispatchEvent(new Event('focus'))")
 expect(guest_tab.locator('body')).to_have_attribute('data-session-state','guest',timeout=15000)
 expect(guest_tab.locator('a[href="/signin"]')).to_have_count(1)
 response=page.request.get(BASE+'/studio',max_redirects=0);assert response.status in [302,303]
 assert not errors,errors
 print('PASS: all public/private/auth pages, mobile navigation, cross-tab login/logout, private cache headers and cached offline screen.')
 b.close()
