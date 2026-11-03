import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
from tui_bridge import StreamBoundary

class BoundaryTests(unittest.TestCase):
    def after(self,*chunks):
        boundary=StreamBoundary()
        for chunk in chunks:boundary.feed(chunk)
        return boundary.safe()
    def test_split_mouse_mode_is_not_a_safe_injection_point(self):
        self.assertFalse(self.after(b'\x1b[?100'))
        self.assertTrue(self.after(b'\x1b[?100',b'6h'))
        self.assertFalse(self.after(b'\x1b'))
    def test_split_osc_and_string_terminators(self):
        self.assertFalse(self.after(b'\x1b]0;title'))
        self.assertFalse(self.after(b'\x1b]0;title\x1b'))
        self.assertTrue(self.after(b'\x1b]0;title\x1b',b'\\'))
        self.assertTrue(self.after(b'\x1b]0;title\x07'))
        self.assertFalse(self.after(b'\x1bP+q'))
    def test_charset_designation_and_split_utf8(self):
        self.assertFalse(self.after(b'\x1b('))
        self.assertTrue(self.after(b'\x1b(B'))
        text='스크롤'.encode()
        self.assertFalse(self.after(text[:4]))
        self.assertTrue(self.after(text[:4],text[4:]))
        self.assertTrue(self.after(b'plain \x1b[31mred\x1b[0m'))

if __name__=='__main__':unittest.main()
