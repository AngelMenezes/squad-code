"""Browser integration tests for the standalone HTML in demo mode (no bridge).
set_content is used with an in-memory Storage-compatible fixture, so nothing touches the bridge, the database or the network.
They do not cover real Claude execution or the bridge's own flows (repository registration, the Painel's repositories):
tests/ui_bridge_test.py starts a temporary bridge for those.
Results go to <SQUAD_PREVIEW_DIR or previews/>/ui-results.json (git-ignored) with the screenshots.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, traceback, os, shutil, sys
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'index.html').read_text(encoding='utf-8')
OUT=Path(os.environ.get('SQUAD_PREVIEW_DIR',str(ROOT/'previews')))
OUT.mkdir(parents=True,exist_ok=True)
results=[]
STORAGE="""(initial) => { const data=new Map(Object.entries(initial||{})); Object.defineProperty(window,'localStorage',{value:{getItem:k=>data.has(String(k))?data.get(String(k)):null,setItem:(k,v)=>data.set(String(k),String(v)),removeItem:k=>data.delete(String(k)),clear:()=>data.clear()}}); }"""

def test(name, condition=True):
    assert condition, name
    results.append({'name':name,'passed':True})
    print('PASS',name,flush=True)

def snap(page): return page.evaluate('SquadCode.getSnapshot()')
def proj(page,pid): return next(p for p in snap(page)['projects'] if p['id']==pid)
def feat(page,pid,fid): return next(f for f in proj(page,pid)['features'] if f['id']==fid)
def close(page):
    if page.locator('#modalRoot .modal').count(): page.locator('#modalRoot [data-action=modal-close]').first.click()
def click(page,action,root='#modalRoot'):
    page.locator(f'{root} [data-action="{action}"]').first.click()
def view(page,name):
    page.locator(f'.mode-nav [data-view={name}]').first.click();page.wait_for_function(f"ui.view==='{name}'||ui.modal==='op-pick'")
    if page.evaluate("ui.modal==='op-pick'"): # more than one operation: the SQUAD tab asks whose squad to show
        page.locator('#modalRoot [data-action=squad-view-op][data-id="%s"]'%page.evaluate('state.projectId')).click();page.wait_for_function(f"ui.view==='{name}'")
def depend(page,fid): # the editor's DEPENDÊNCIAS row is collapsed while a feature waits only for the setup
    if not page.evaluate("document.querySelector('#featureForm details.fe-deps').open"): page.locator('#featureForm details.fe-deps > summary').click()
    page.locator(f'label:has([name=dependencies][value="{fid}"])').click()
def saved(page,pid,n): # waits for the feature count, and says what the screen showed when it does not get there
    try: page.wait_for_function(f"state.projects.find(p=>p.id==='{pid}').features.length==={n}",timeout=5000)
    except Exception: raise AssertionError(f"expected {n} features, modal={page.evaluate('ui.modal')}, toasts={toasts(page)[-300:]!r}")
def act(page,action): page.locator(f'[data-action="{action}"]:visible').first.click() # review modal or the operation page's detail
def approve(page): act(page,'feature-approve')
def toasts(page): return page.locator('#toastRoot').inner_text()
def wait_not_running(page):page.wait_for_function('!runner',timeout=30000)
def wait_phase(page,phase):page.wait_for_function(f"runner&&runner.phase==='{phase}'",timeout=20000)
def cards(page): return page.evaluate("[...document.querySelectorAll('.home-project:not(.new)')].map(c=>({code:c.querySelector('.eyebrow').textContent,tone:c.querySelector('.home-next').dataset.tone,label:c.querySelector('.home-next strong').textContent,button:c.querySelector('.home-project-foot .btn.primary').textContent}))")
def actions(page): return page.evaluate("[...document.querySelectorAll('.home-grid .home-list:not(.home-activity-list) .home-review')].map(b=>b.querySelector('.plan-key').textContent)")

with sync_playwright() as pw:
 binary=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
 browser=pw.chromium.launch(executable_path=binary,headless=True)
 context=browser.new_context(viewport={'width':1600,'height':1000},device_scale_factor=1,reduced_motion='reduce') # no transitions: layout never moves under a click
 context.set_default_timeout(30000)
 page=context.new_page();errors=[];requests=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:requests.append(r.url))
 page.evaluate(STORAGE,{})
 page.set_content(HTML,wait_until='load')
 page.wait_for_timeout(200)
 page.evaluate("state.settings.mapQuality='low';render()") # software WebGL in headless Chromium: the plain render keeps clicks fast
 try:
    # Boot and Painel.
    s=snap(page);seed=s['projectId']
    test('Boots with six agents, the approved setup and six sample features',len(s['agents'])==6 and len(s['projects'][0]['features'])==7 and s['projects'][0]['features'][0]['setup'] and s['projects'][0]['features'][0]['status']=='done')
    test('Boots on the Painel',page.evaluate('ui.view')=='home' and page.locator('#homeView .home-project').count()==2)
    c=cards(page)
    test('Painel card shows the next step of the operation',c==[{'code':'OP-001','tone':'ready','label':'Sprint 01 pronta para executar','button':'Simular Sprint 01'}])
    test('Nothing running and nothing waiting on the Painel','Nada em execução' in page.locator('.home-run.idle').inner_text() and actions(page)==[] and page.locator('.home-grid .home-empty').count()>=1)
    test('Demo mode shows no repositories and no activity filter with one operation',page.locator('.home-repos-wrap').count()==0 and page.locator('.home-chips').count()==0)

    # Squad map and agents.
    view(page,'network')
    test('Six independently interactive map nodes',page.locator('.map-node').count()==6)
    page.locator('#leftHud [data-id="agent-backend"]').click()
    test('Selecting a map agent updates the inspector',page.locator('.identity-name').inner_text()=='FORGE')
    click(page,'agent-edit','#rightHud')
    page.locator('#agentName').fill('FORGE API')
    page.locator('#agentDescription').fill('Backend, contracts and persistence.')
    page.locator('[data-tab=prompt]').click()
    page.locator('#agentPrompt').fill('You are the API engineer. Use functional TypeScript and validate all inputs.')
    page.locator('[data-tab=tools]').click()
    page.locator('[name=tools][value=Glob]').uncheck()
    page.locator('button[form=agentForm]').click()
    backend=next(a for a in snap(page)['agents'] if a['id']=='agent-backend')
    test('Agent edits persist across editor tabs',backend['name']=='FORGE API' and 'Glob' not in backend['tools'] and 'functional TypeScript' in backend['prompt'])
    click(page,'agent-edit','#rightHud');click(page,'agent-duplicate')
    test('Duplicate gets a distinct ID and name',len(snap(page)['agents'])==7)
    page.locator('#agentName').fill('NOVA')
    page.locator('#agentRole').select_option('frontend')
    page.locator('[data-action=look-open][data-kind=photo]').click()
    page.locator('[data-action=portrait-pick]:not([data-preset=""])').first.click()
    page.wait_for_function("ui.draft.agent.image.startsWith('data:image/')")
    picked=page.evaluate('ui.draft.agent.image')
    page.locator('button[form=agentForm]').click()
    nova=next(a for a in snap(page)['agents'] if a['name']=='NOVA')
    test('A photo picked from the gallery is stored with the agent',nova['image']==picked and nova['role']=='frontend')
    page.evaluate(f"openAgentEditor('{nova['id']}')");click(page,'agent-delete');click(page,'confirm')
    test('Deletion removes the agent',len(snap(page)['agents'])==6 and all(nova['id'] not in p['agentIds'] for p in snap(page)['projects']))

    # Nova operação: three-step wizard (name, code, squad).
    view(page,'home');click(page,'project-new','#homeView')
    page.locator('button[form=opNewForm]').click()
    test('Nova operação refuses an empty name',page.locator('#opNewName').count()==1 and len(snap(page)['projects'])==1)
    page.locator('#opNewName').fill('Mission Control');page.locator('button[form=opNewForm]').click()
    test('Without the bridge an existing repository is not offered',page.locator('[name=kind][value=existing]').is_disabled() and 'Disponível com o bridge' in page.locator('#opNewCodeForm').inner_text())
    page.locator('button[form=opNewCodeForm]').click()
    click(page,'op-new-existing');page.locator('button[form=opNewSquadForm]').click()
    s=snap(page);pid=s['projectId'];p=proj(page,pid)
    test('Nova operação creates the project at once with code, squad, folder and one sprint',len(s['projects'])==2 and p['code']=='OP-002' and p['name']=='Mission Control' and p['commanderId']=='agent-commander' and p['folder'] and len(p['sprints'])==1 and p['briefing']=='')
    setup=p['features'][0]
    test('Sprint 01 of a new operation starts with the project setup',len(p['features'])==1 and setup['setup'] and setup['key']=='F00' and setup['sprintId']==p['sprints'][0]['id'])
    view(page,'home')
    c=cards(page)
    test('The new operation card asks for the briefing',c[1]['code']=='OP-002' and c[1]['label']=='Briefing pendente' and c[1]['button']=='Completar briefing')
    test('Two operations show the activity filter',page.evaluate("[...document.querySelectorAll('.home-chip')].map(c=>c.textContent)")==['Todas','OP-001','OP-002'])

    # Run gate, briefing and documentation.
    view(page,'network');click(page,'run','#rightHud')
    test('Runs are refused while the documentation is incomplete',page.evaluate('!runner') and 'Preencha' in toasts(page) and page.evaluate('ui.view')=='projects')
    page.locator('#projectBriefing').fill('Build a local project management application with clear acceptance criteria, safe input validation and human approval.')
    page.evaluate("""(()=>{const f=document.getElementById('projectForm');for(const [k,v] of Object.entries({vision:'A clear view of every project.',scopeIn:'Projects, tasks and reviews.',scopeOut:'Billing.',glossary:'Task: a unit of work.',architecture:'Single page app over a local API.'}))f.elements.namedItem(k).value=v;})()""")
    page.evaluate("document.querySelectorAll('#projectForm details').forEach(d=>d.open=true)") # the documentation rows are collapsed
    click(page,'adr-add','#projectsView')
    page.evaluate("""(()=>{const f=document.getElementById('projectForm');[...f.querySelectorAll('[name=adrTitle]')].at(-1).value='Local storage first';[...f.querySelectorAll('[name=adrContent]')].at(-1).value='Data stays on this machine.';})()""")
    page.locator('button[form=projectForm]').click()
    test('Briefing, documentation and ADR are saved and complete the project',page.evaluate(f"projectGaps(state.projects.find(p=>p.id==='{pid}')).length")==0 and proj(page,pid)['briefing'].startswith('Build a local'))

    # Features, dependencies on the setup, search and cycles.
    page.evaluate("setupOf().status='done';save();render()") # every other feature waits for the approved setup
    for title in ('Workspace overview','Agent directory'):
        n=len(proj(page,pid)['features'])
        click(page,'feature-new','#projectsView')
        page.locator('#featureTitle').fill(title)
        page.locator('#featureCriteria').fill('Visible, validated and approved by a human.')
        page.locator('button[form=featureForm]').click()
        saved(page,pid,n+1)
    p=proj(page,pid)
    test('Features are created in the operation',len(p['features'])==3)
    f1,f2=[f['id'] for f in p['features'] if not f['setup']]
    test('New features depend on the project setup',all(f['dependencies']==[setup['id']] for f in p['features'] if not f['setup']))
    click(page,'feature-new','#projectsView')
    page.locator('#featureTitle').fill('Audit trail')
    page.locator('#featureScope').select_option('qa')
    page.locator('#featurePriority').select_option('P2')
    page.locator('#featureCriteria').fill('Record all operations and verify visible state changes.')
    depend(page,f1) # right after typing: the criteria field shrinks to its preview only after the click is released
    test('The first click after typing a Markdown field lands, and the field returns to its preview',page.locator(f'#featureForm [name=dependencies][value="{f1}"]').is_checked() and page.evaluate("!document.querySelector('#featureForm .fe-md:has(#featureCriteria)').classList.contains('editing')"))
    page.locator('button[form=featureForm]').click()
    saved(page,pid,4)
    f3=next(f['id'] for f in proj(page,pid)['features'] if f['title']=='Audit trail');a3=feat(page,pid,f3)
    test('Feature creation stores scope, priority and dependencies',a3['scope']=='qa' and a3['priority']=='P2' and set(a3['dependencies'])=={setup['id'],f1})
    page.locator('#featureSearch').fill('Audit')
    test('Feature search filters the list',page.evaluate("ui.featureQuery")=='Audit' and page.locator('#projectsView').inner_text().count('Workspace overview')==0)
    page.locator('#featureSearch').fill('')
    page.evaluate(f"openFeature('{f1}')")
    depend(page,f3)
    page.locator('button[form=featureForm]').click()
    test('Cyclic dependencies are rejected without changing data',page.locator('#featureForm').count()==1 and feat(page,pid,f1)['dependencies']==[setup['id']])
    close(page)

    # Manual handoff.
    view(page,'handoffs')
    click(page,'handoff-new','#rightHud')
    page.locator('#handoffFrom').select_option('agent-backend')
    page.locator('#handoffTo').select_option('agent-frontend')
    page.locator('#handoffFeature').select_option(f1)
    page.locator('#handoffContext').fill('API contracts and acceptance criteria must travel with this feature.')
    page.locator('button[form=handoffForm]').click()
    p=proj(page,pid)
    test('Manual handoff records context and updates the pending route',len(p['handoffs'])==1 and feat(page,pid,f1)['route']==['agent-backend','agent-frontend'])

    # Demo run: the commander plans, the person approves, the route runs and ends in human review.
    click(page,'settings','.system-meta');page.locator('#demoSpeed').select_option('600');close(page)
    view(page,'network');click(page,'run','#rightHud');wait_phase(page,'awaiting')
    test('The commander plans the sprint and waits for approval',all(not feat(page,pid,f)['outputs'] for f in (f1,f2)))
    view(page,'home')
    c=cards(page)
    test('Painel while the plan waits: live card, EM EXECUÇÃO names the operation, PLANO first in Aguardando sua ação',c[1]['tone']=='live' and c[1]['button']=='Aprovar no chat' and 'OP-002' in page.locator('.home-run.live').inner_text() and actions(page)[:1]==['PLANO'])
    page.locator(".home-review:has(.plan-key:text-is('PLANO'))").click();page.wait_for_function("ui.view==='network'")
    test('The plan item opens the operation chat',page.evaluate('ui.opsChat.open'))
    click(page,'run','#rightHud');wait_phase(page,'running')
    click(page,'run','#rightHud')
    test('Demo can be paused',page.evaluate('runner.paused') is True)
    before=page.evaluate('activeFeature()?.step');page.wait_for_timeout(750)
    test('Paused simulation does not advance',page.evaluate('activeFeature()?.step')==before)
    click(page,'run','#rightHud');wait_not_running(page)
    a1,a2=feat(page,pid,f1),feat(page,pid,f2)
    test('Simulated run produces per-agent reports and waits for human review',a1['status']=='review' and a2['status']=='review' and len(a1['outputs'])==len(a1['route'])>0)
    test('Dependents wait for the approval',feat(page,pid,f3)['status'] in ('blocked','backlog'))

    # The Painel after the run.
    view(page,'home')
    test('Aguardando sua ação lists the deliveries of the operation',sorted(actions(page))==sorted([a1['key'],a2['key']]) and '2 itens aguardam sua ação' in page.locator('#homeView .home-head p').inner_text())
    c=cards(page)
    test('The operation card asks for the review',c[1]['tone']=='review' and c[1]['button']=='Revisar')
    page.locator(".home-chip:text-is('OP-002')").click()
    test('The activity filter shows only that operation',set(page.evaluate("[...document.querySelectorAll('.home-activity-body strong')].map(s=>s.textContent.split(' / ')[0])"))=={'OP-002'})
    page.locator(".home-chip:text-is('Todas')").click()
    page.locator(".home-project:has(.eyebrow:text-is('OP-002')) .home-project-foot .btn.primary").click()
    approve(page)
    test('Human approval marks only the reviewed feature complete',feat(page,pid,f1)['status']=='done' and feat(page,pid,f2)['status']=='review')
    test('An approved dependency unlocks the dependent feature',page.evaluate(f"depsReady(featureById('{f3}'))"))
    page.evaluate(f"openFeature('{f2}')");act(page,'feature-rework')
    test('Review can request another iteration',feat(page,pid,f2)['status']=='ready')
    close(page)

    # Individual spawn skips the commander.
    view(page,'network');click(page,'ops-chat-close','#opsChat') # after a run the chat stays docked over the roster until closed
    test('The operation chat closes after the run and gives the roster back',page.locator('#leftHud [data-id=agent-backend]').is_visible())
    page.locator('#leftHud [data-id=agent-backend]').click();click(page,'spawn','#rightHud')
    page.locator('#spawnFeature').select_option(f2);page.locator('button[form=spawnForm]').click();wait_not_running(page)
    a2=feat(page,pid,f2)
    test('Individual spawn uses only the selected agent and returns to review',a2['route']==['agent-backend'] and a2['status']=='review')
    page.evaluate(f"openFeature('{f2}')");approve(page)
    view(page,'network');click(page,'run','#rightHud');wait_phase(page,'awaiting');click(page,'run','#rightHud');wait_not_running(page)
    page.evaluate(f"openFeature('{f3}')");approve(page)
    view(page,'network')
    test('Progress reaches 100 percent only after every human approval',page.locator('#operationProgress .progress-caption strong').inner_text()=='100%')
    view(page,'home')
    test('A finished sprint offers the next one',cards(page)[1]['button']=='Planejar próxima sprint')

    # Map controls, focus mode, history and log.
    view(page,'network');page.wait_for_timeout(300)
    before=page.evaluate('MapNetwork.getCamera()')
    click(page,'zoom-in','.map-side-controls')
    test('Zoom controls change the map camera',page.evaluate('MapNetwork.getCamera().scale')>before['scale'])
    click(page,'map-reset','.map-side-controls')
    test('Home restores the camera scale',abs(page.evaluate('MapNetwork.getCamera().scale')-before['scale'])<0.001)
    page.mouse.move(800,700);page.mouse.down();page.mouse.move(870,730,steps=8);page.mouse.up()
    after=page.evaluate('MapNetwork.getCamera()')
    test('Canvas pan moves the camera',after['scale']==before['scale'] and after!=before) # city or office view: the framing moves, not the zoom
    click(page,'map-reset','.map-side-controls')
    page.keyboard.press('h');test('Focus mode hides interactive HUD regions',page.locator('#workspace').evaluate("e=>e.classList.contains('focus-mode')"))
    page.locator('#restoreHud').click()
    test('Focus mode can restore all panels',not page.locator('#leftHud').evaluate('e=>e.inert'))
    view(page,'handoffs');click(page,'handoff-history','#rightHud')
    test('Handoff history shows accumulated transfers',page.locator('.timeline-row').count()>=5)
    close(page);page.keyboard.press('l')
    click(page,'log-filter');test('Operation log is readable and filterable',page.locator('.log-grid').count()>0)
    close(page)

    # Operation codes are never reused after a deletion.
    page.evaluate("createOperation('Temporary',squadById(project().squadId))")
    tmp=page.evaluate('state.projectId');view(page,'projects')
    page.locator(f'#projectsView [data-action=project-delete][data-id="{tmp}"]').click();click(page,'confirm')
    test('Deleting an operation keeps the others',[p['code'] for p in snap(page)['projects']]==['OP-001','OP-002'])
    click(page,'project-new','#projectsView');page.locator('#opNewName').fill('After delete');page.locator('button[form=opNewForm]').click()
    page.locator('button[form=opNewCodeForm]').click();click(page,'op-new-existing');page.locator('button[form=opNewSquadForm]').click()
    test('A deleted operation code is never given again',[p['code'] for p in snap(page)['projects']]==['OP-001','OP-002','OP-004'])

    # State output and re-hydration are checked with a storage fixture, not OS persistence.
    stored=page.evaluate("localStorage.getItem('squad-code.network.v2')")
    fresh=context.new_page();fresh.evaluate(STORAGE,{'squad-code.network.v2':stored});fresh.set_content(HTML);fresh.wait_for_timeout(150)
    test('Workspace serializes and rehydrates with the storage fixture',fresh.evaluate('SquadCode.getSnapshot().projects.length')==3 and fresh.evaluate('SquadCode.getSnapshot().projectId')==snap(page)['projectId'] and fresh.evaluate('state.settings.opSeq')==4)
    fresh.close()
    test('Exported snapshot is isolated from internal state',page.evaluate("(()=>{const x=SquadCode.getSnapshot();x.agents.length=0;return SquadCode.getSnapshot().agents.length===6})()"))
    test('Invalid workspace versions are rejected',page.evaluate("(()=>{try{normalizeWorkspace({version:42,agents:[],projects:[]});return false}catch{return true}})()"))
    test('Unknown roles are rejected',page.evaluate("(()=>{const x=SquadCode.getSnapshot();x.agents[0].role='constructor';try{normalizeWorkspace(x);return false}catch{return true}})()"))
    test('Unsafe uploaded image URLs are removed on import',page.evaluate("(()=>{const x=SquadCode.getSnapshot();x.agents[0].image='javascript:alert(1)';return normalizeWorkspace(x).agents[0].image==='';})()"))
    test('An old backup without opSeq takes it from the codes in use',page.evaluate("(()=>{const x=SquadCode.getSnapshot();delete x.settings.opSeq;x.projects[0].code='OP-007';return normalizeWorkspace(x).settings.opSeq===7})()"))
    test('No network requests are needed',not any(url.startswith(('http://','https://')) for url in requests))
    test('No uncaught browser errors',not errors)

    # Screenshots of a fresh workspace, desktop and phone.
    art=context.new_page();art.evaluate(STORAGE,{});art.set_content(HTML);art.wait_for_timeout(500)
    art.screenshot(path=str(OUT/'squad-code-network-painel.png'))
    view(art,'network');art.wait_for_timeout(300);art.screenshot(path=str(OUT/'squad-code-network-preview.png'))
    view(art,'handoffs');art.wait_for_timeout(300);art.locator('#toastRoot').evaluate('e=>e.innerHTML=""')
    art.screenshot(path=str(OUT/'squad-code-network-handoffs.png'))
    click(art,'agent-edit','#rightHud');art.wait_for_timeout(300)
    art.screenshot(path=str(OUT/'squad-code-network-studio.png'))
    close(art);art.keyboard.press('f');art.wait_for_timeout(300)
    art.screenshot(path=str(OUT/'squad-code-network-features.png'))
    art.close()
    mobile=context.new_page();mobile.set_viewport_size({'width':390,'height':844});mobile.evaluate(STORAGE,{});mobile.set_content(HTML);mobile.wait_for_timeout(300)
    test('Mobile Painel has no horizontal page overflow',mobile.evaluate('document.documentElement.scrollWidth<=innerWidth') and mobile.evaluate("document.querySelector('#homeView').scrollWidth<=document.querySelector('#homeView').clientWidth"))
    mobile.screenshot(path=str(OUT/'squad-code-network-mobile.png'))
    view(mobile,'network');mobile.locator('#leftHud [data-id=agent-commander]').click()
    test('Mobile agent selection selects the agent',mobile.evaluate('ui.selectedId')=='agent-commander')
    act(mobile,'agent-edit')
    test('Mobile agent studio opens and is usable',mobile.locator('#agentForm').is_visible() and mobile.evaluate("document.querySelector('#modalRoot .modal').getBoundingClientRect().width<=innerWidth"))
    mobile.screenshot(path=str(OUT/'squad-code-network-mobile-studio.png'))
    close(mobile);mobile.keyboard.press('f')
    test('Mobile feature list is reachable',mobile.evaluate("ui.view")=='projects' and mobile.locator('#opsFeatures').is_visible())
 except Exception as exc:
    try: page.screenshot(path=str(OUT/'squad-code-network-test-failure.png'))
    except Exception: pass
    results.append({'name':'failure','passed':False,'error':str(exc)})
    traceback.print_exc()
 finally:
    passed=sum(r['passed'] for r in results);failed=sum(not r['passed'] for r in results)
    (OUT/'ui-results.json').write_text(json.dumps({'tests':results,'passed':passed,'failed':failed,'browser_errors':errors,'limitations':['Demo mode only: set_content and a Storage-compatible in-memory fixture, no bridge.','No authenticated Claude Code runtime was tested.']},indent=2))
    print('PASSED',passed,'FAILED',failed,'BROWSER ERRORS',errors)
    browser.close()

if any(not item['passed'] for item in results):
    sys.exit(1)
