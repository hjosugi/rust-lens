#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="$(node -p "require('${repo_root}/package.json').name")"
version="$(node -p "require('${repo_root}/package.json').version")"
display_name="$(node -p "require('${repo_root}/package.json').displayName")"
description="$(node -p "require('${repo_root}/package.json').description")"
publisher="$(node -p "require('${repo_root}/package.json').publisher")"
outfile="${repo_root}/${name}-${version}.vsix"
tmpdir="$(mktemp -d)"

cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

mkdir -p "${tmpdir}/extension"
cp "${repo_root}/package.json" "${tmpdir}/extension/package.json"
cp "${repo_root}/extension.js" "${tmpdir}/extension/extension.js"
cp "${repo_root}/README.md" "${tmpdir}/extension/README.md"
if [[ -f "${repo_root}/README.ja.md" ]]; then
  cp "${repo_root}/README.ja.md" "${tmpdir}/extension/README.ja.md"
fi
cp "${repo_root}/CHANGELOG.md" "${tmpdir}/extension/CHANGELOG.md"
cp "${repo_root}/LICENSE" "${tmpdir}/extension/LICENSE"
cp -R "${repo_root}/media" "${tmpdir}/extension/media"
if [[ -d "${repo_root}/docs" ]]; then
  cp -R "${repo_root}/docs" "${tmpdir}/extension/docs"
fi

cat > "${tmpdir}/[Content_Types].xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
</Types>
XML

cat > "${tmpdir}/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${name}" Version="${version}" Publisher="${publisher}"/>
    <DisplayName>${display_name}</DisplayName>
    <Description xml:space="preserve">${description}</Description>
    <Tags>rust,ownership,borrow-checker,lifetime,cargo</Tags>
    <Categories>Programming Languages,Linters,Education</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
  </Assets>
</PackageManifest>
XML

rm -f "${outfile}"
(cd "${tmpdir}" && zip -qr "${outfile}" .)
echo "Wrote ${outfile}"
