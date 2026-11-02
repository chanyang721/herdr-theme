import json,os,sys,tempfile,unittest,unicodedata
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from collect_docs import collect,documents,owned_links

class DocumentTests(unittest.TestCase):
    def test_filter_extensions_and_latest_order_without_following_links(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)
            for name in ['PMO-old.md','PMO-new.pdf','PMO-sheet.xlsx','PMO-word.docx','other.md','PMO.before-old.md','latest.md','PMO.txt']:(folder/name).write_text('test')
            os.utime(folder/'PMO-new.pdf',ns=(100000000000,100000000000))
            os.utime(folder/'PMO-old.md',ns=(90000000000,90000000000))
            (folder/'PMO-link.md').symlink_to(folder/'PMO-old.md')
            rows=documents([{'path':str(folder),'match':['pmo']}])
            self.assertEqual({row['name'] for row in rows},{'PMO-old.md','PMO-new.pdf','PMO-sheet.xlsx','PMO-word.docx'})
            self.assertLess([r['name'] for r in rows].index('PMO-new.pdf'),[r['name'] for r in rows].index('PMO-old.md'))

    def test_real_files_and_unowned_symlinks_are_never_replaced_or_deleted(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);src=base/'source';src.mkdir();target=base/'project';target.mkdir()
            doc=src/'guide.md';doc.write_text('original')
            (target/'guide.md').write_text('user document')
            (target/'unowned.md').symlink_to(base/'missing')
            self.assertIsNone(owned_links(target,[{'path':str(doc),'name':doc.name}]))
            manifest=json.loads((target/'.herdr-document-links.json').read_text());managed=next(iter(manifest['links']))
            self.assertNotEqual(managed,'guide.md');self.assertTrue((target/managed).is_symlink())
            # User replaces one managed symlink with an actual document before collection.
            (target/managed).unlink();(target/managed).write_text('another user document');doc.unlink()
            owned_links(target,[])
            self.assertEqual((target/'guide.md').read_text(),'user document')
            self.assertEqual((target/managed).read_text(),'another user document')
            self.assertTrue((target/'unowned.md').is_symlink())

    def test_only_missing_sources_remove_owned_links_and_excluded_sources_stay(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);target=base/'out';doc=base/'guide.md';doc.write_text('original')
            owned_links(target,[{'path':str(doc),'name':doc.name}]);owned_links(target,[])
            self.assertTrue((target/doc.name).is_symlink())
            doc.unlink();owned_links(target,[]);self.assertFalse(os.path.lexists(target/doc.name))

    def test_stable_index_and_manifest_conflict_preserve_user_files(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);source=base/'source';source.mkdir();(source/'guide.md').write_text('guide')
            target=base/'target';target.mkdir();manifest=target/'.herdr-document-links.json';manifest.write_text('user content')
            config=base/'config.json';config.write_text(json.dumps({'version':1,'spaces':{'Demo':{'folders':[str(source)],'target':str(target)}}}))
            index=base/'index.json';result=collect(config,index);before=index.stat().st_mtime_ns;collect(config,index)
            self.assertEqual(index.stat().st_mtime_ns,before);self.assertEqual(manifest.read_text(),'user content')
            self.assertEqual(result['spaces']['Demo']['warning'],'manifest_conflict')

    def test_inaccessible_or_missing_source_is_not_silently_reported_as_empty(self):
        with tempfile.TemporaryDirectory() as root:
            warnings=[];self.assertEqual(documents([str(Path(root)/'missing')],warnings),[])
            self.assertEqual(warnings,['source_unavailable'])

    def test_korean_filename_and_match_accept_both_nfc_and_nfd_without_renaming(self):
        for filename_form in ('NFC','NFD'):
            for match_form in ('NFC','NFD'):
                with self.subTest(filename=filename_form,match=match_form),tempfile.TemporaryDirectory() as root:
                    folder=Path(root)
                    name=unicodedata.normalize(filename_form,'메디홈즈-보고서-PMO.md')
                    original=folder/name;original.write_text('original document')
                    original_names=os.listdir(folder)
                    term=unicodedata.normalize(match_form,'메디홈즈')
                    rows=documents([{'path':str(folder),'match':[term]}])
                    self.assertEqual(len(rows),1)
                    self.assertEqual(unicodedata.normalize('NFC',rows[0]['name']),'메디홈즈-보고서-PMO.md')
                    self.assertEqual(Path(rows[0]['path']).read_text(),'original document')
                    self.assertEqual(os.listdir(folder),original_names)
                    self.assertEqual(documents([{'path':str(folder),'match':'다른프로젝트'}]),[])

    def test_archive_classification_and_original_folder_structure(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root)/'source';source.mkdir()
            names=['current/guide.md','Archive/old.pdf','ARCHIVE-backup/old.docx',
                   '아카이브/old.xlsx','보관함/old.md','current/guide.before-update.md',
                   'current/.before-guide.md']
            names.append(unicodedata.normalize('NFD','아카이브-한글/보고서.md'))
            for name in names:
                path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(name)
            self.assertEqual([row['relativePath'] for row in documents([str(source)])],['current/guide.md'])
            rows=documents([str(source)],include_archived=True)
            self.assertEqual(len(rows),len(names))
            for row in rows:
                self.assertEqual(row['sourceRoot'],str(source.resolve()))
                self.assertEqual(row['folder'],str(Path(row['path']).parent))
                self.assertEqual(row['archived'],row['relativePath']!='current/guide.md')
                self.assertEqual((source/row['relativePath']).read_text(),row['relativePath'])

    def test_archive_source_root_is_classified_and_index_keeps_it_without_new_links(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);source=base/'보관';source.mkdir();doc=source/'guide.md';doc.write_text('original')
            config=base/'config.json';config.write_text(json.dumps({'version':1,'spaces':{'Demo':{'folders':[str(source)],'target':str(base/'target')}}}))
            original_config=config.read_bytes();original_doc=doc.read_bytes()
            self.assertEqual(documents([str(source)]),[])
            result=collect(config,base/'index.json')
            row=result['spaces']['Demo']['files'][0]
            self.assertTrue(row['archived'])
            self.assertEqual(row['relativePath'],'guide.md')
            self.assertFalse(os.path.lexists(base/'target'/'guide.md'))
            self.assertEqual(config.read_bytes(),original_config)
            self.assertEqual(doc.read_bytes(),original_doc)
