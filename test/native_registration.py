"""Native registration tests use only temporary homes and an in-memory registry."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / 'installer/native_registration.py'
spec = importlib.util.spec_from_file_location('native_registration', SOURCE)
reg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reg)
ID = 'abcdefghijklmnopabcdefghijklmnop'


class FakeRegistry:
    def __init__(self): self.values = {}; self.fail = None
    def read(self, browser, view): return self.values.get((browser, view))
    def write(self, browser, view, value):
        if self.fail == (browser, view):
            self.fail = None
            raise OSError('injected registry error')
        if value is None: self.values.pop((browser, view), None)
        else: self.values[(browser, view)] = value


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.user = Path(self.temp.name).resolve() / 'user'
        self.home = self.user / 'component with spaces'
        for p in ('app', 'bin', 'run'): (self.home / p).mkdir(parents=True, exist_ok=True)
        (self.home / '.anagram-home').write_text('owned')
        (self.home / 'app/native_host.py').write_text('# fixture')
        (self.home / 'bin/anagram-native.exe').write_bytes(b'fixture')
        self.registry = FakeRegistry()

    def register(self, browser='chrome', extension=ID, platform='linux', language='en'):
        return reg.register(self.home, browser, extension, language, user_home=self.user,
                            platform=platform, registry=self.registry)

    def unregister(self, platform='linux'):
        return reg.unregister(self.home, user_home=self.user, platform=platform, registry=self.registry)

    def test_exact_chrome_origin_and_private_launcher(self):
        e = self.register()
        d = json.loads(Path(e['manifest']).read_text())
        self.assertEqual(d['allowed_origins'], ['chrome-extension://' + ID + '/'])
        self.assertEqual(d['path'], str(self.home / 'bin/anagram-native'))
        script = Path(d['path']).read_text()
        self.assertIn(' -I -u ', script)
        self.assertIn('prepare --home', script)
        self.assertNotIn('python3 ', script)
        if os.name != 'nt': self.assertEqual(Path(e['manifest']).stat().st_mode & 0o777, 0o600)
        marker = json.loads((self.home / reg.OWNER).read_text())
        self.assertEqual(marker['home'], str(self.home))

    def test_mac_firefox_and_chrome_paths(self):
        first = self.register(platform='darwin')
        second = self.register('firefox', reg.FIREFOX_ID, 'darwin', 'zh_CN')
        self.assertIn('Library/Application Support/Google/Chrome/', Path(first['manifest']).as_posix())
        self.assertIn('Library/Application Support/Mozilla/', Path(second['manifest']).as_posix())
        self.assertEqual(json.loads(Path(second['manifest']).read_text())['allowed_extensions'], [reg.FIREFOX_ID])
        self.unregister('darwin')
        self.assertFalse(Path(first['manifest']).exists())
        self.assertFalse(Path(second['manifest']).exists())

    def test_invalid_origin_and_language_refused_without_writes(self):
        for browser, extension, language in [('chrome','*','en'),('chrome','a'*31,'en'),('chrome','z'*32,'en'),('firefox','foreign@example.org','en'),('chrome',ID,'xx')]:
            with self.assertRaises(ValueError): self.register(browser,extension,language=language)
        self.assertFalse((self.home / reg.INVENTORY).exists())

    def test_foreign_manifest_not_overwritten(self):
        path = reg.manifest_path(self.home,self.user,'chrome','linux')
        path.parent.mkdir(parents=True); path.write_text('foreign')
        with self.assertRaisesRegex(ValueError,'different'): self.register()
        self.assertEqual(path.read_text(),'foreign')

    @unittest.skipIf(os.name == 'nt', 'unprivileged Windows symlinks vary by policy')
    def test_registration_parent_symlink_refused(self):
        outside = self.user / 'outside'; outside.mkdir()
        (self.user / '.config').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'link'): self.register()
        self.assertEqual(list(outside.iterdir()),[])

    def test_modified_registration_is_not_deleted(self):
        e = self.register(); path = Path(e['manifest']); path.write_text('another owner')
        with self.assertRaisesRegex(ValueError,'modified'): self.unregister()
        self.assertEqual(path.read_text(),'another owner')
        self.assertTrue((self.home / reg.INVENTORY).exists())

    def test_inventory_cannot_redirect_cleanup(self):
        self.register(); path = self.home / reg.INVENTORY
        value = json.loads(path.read_text()); victim = self.user / 'victim'; victim.write_text('keep')
        value['registrations'][0]['manifest'] = str(victim); path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'unexpected'): self.unregister()
        self.assertEqual(victim.read_text(),'keep')

    def test_windows_exact_hkcu_views_and_unregistration(self):
        e = self.register(platform='win32')
        self.assertEqual(self.registry.values,{('chrome',32):e['manifest'],('chrome',64):e['manifest']})
        self.assertIn('Software\\Google\\Chrome\\NativeMessagingHosts\\',reg.registry_key('chrome'))
        self.unregister('win32')
        self.assertEqual(self.registry.values,{})
        self.assertFalse(Path(e['manifest']).exists())

    def test_failed_windows_registration_rolls_back(self):
        self.registry.fail = ('chrome',64)
        with self.assertRaises(OSError): self.register(platform='win32')
        self.assertEqual(self.registry.values,{})
        self.assertFalse(reg.manifest_path(self.home,self.user,'chrome','win32').exists())
        self.assertFalse((self.home / reg.INVENTORY).exists())

    def test_foreign_registry_owner_preserved(self):
        self.registry.values[('chrome',32)] = 'C:\\foreign.json'
        with self.assertRaisesRegex(ValueError,'different'): self.register(platform='win32')
        self.assertEqual(self.registry.values[('chrome',32)],'C:\\foreign.json')

    def test_failed_windows_unregistration_restores_owned_keys(self):
        entry=self.register(platform='win32')
        before=dict(self.registry.values)
        self.registry.fail=('chrome',64)
        with self.assertRaises(OSError): self.unregister('win32')
        self.assertEqual(self.registry.values,before)
        self.assertTrue(Path(entry['manifest']).exists())

    def test_readonly_inventory_owner_mismatch(self):
        self.register(); marker=self.home/reg.OWNER
        d=json.loads(marker.read_text());d['home']=str(self.user);marker.write_text(json.dumps(d))
        with self.assertRaisesRegex(ValueError,'ownership'): self.unregister()

    def test_migration_stops_only_the_verified_legacy_process(self):
        self.register()
        pidfile = self.home / 'run/anagramd.pid'
        pidfile.write_text('12345')
        calls = []
        process = types.SimpleNamespace(
            cmdline=lambda: [str(self.home / ('venv/Scripts/python.exe' if sys.platform == 'win32' else 'venv/bin/python')),
                             str(self.home / 'app/serve.py')],
            terminate=lambda: calls.append('terminate'),
            wait=lambda timeout: calls.append(('wait', timeout)))
        psutil = types.SimpleNamespace(Process=lambda pid: process, NoSuchProcess=ProcessLookupError)
        with patch.dict(sys.modules, {'psutil': psutil}):
            reg.prepare(self.home)
        self.assertEqual(calls, ['terminate', ('wait', 15)])
        self.assertFalse(pidfile.exists())

    def test_migration_preserves_an_unrelated_process_and_pid_file(self):
        self.register()
        pidfile = self.home / 'run/anagramd.pid'
        pidfile.write_text('12345')
        calls = []
        process = types.SimpleNamespace(cmdline=lambda: ['/foreign/python', '/foreign/app.py'],
                                        terminate=lambda: calls.append('terminate'))
        psutil = types.SimpleNamespace(Process=lambda pid: process, NoSuchProcess=ProcessLookupError)
        with patch.dict(sys.modules, {'psutil': psutil}), self.assertRaisesRegex(ValueError, 'another process'):
            reg.prepare(self.home)
        self.assertEqual(calls, [])
        self.assertEqual(pidfile.read_text(), '12345')

    @unittest.skipIf(os.name == 'nt', 'Windows uses the detached maintenance worker')
    def test_uninstall_removes_only_owned_home_and_manifest(self):
        self.register(platform=sys.platform)
        victim=self.user/'keep';victim.write_text('keep')
        with patch.object(reg.Path,'home',return_value=self.user): reg.uninstall(self.home)
        self.assertFalse(self.home.exists());self.assertEqual(victim.read_text(),'keep')

    @unittest.skipIf(os.name == 'nt', 'unprivileged Windows symlinks vary by policy')
    def test_uninstall_never_follows_nested_file_or_directory_links(self):
        self.register(platform=sys.platform)
        outside=self.user/'outside';outside.mkdir();(outside/'keep').write_text('keep')
        (self.home/'nested').symlink_to(outside,target_is_directory=True)
        with patch.object(reg.Path,'home',return_value=self.user): reg.uninstall(self.home)
        self.assertEqual((outside/'keep').read_text(),'keep')


if __name__ == '__main__': unittest.main()
