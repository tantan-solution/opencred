/*!
 * Copyright 2023 - 2024 California Department of Motor Vehicles
 * Copyright 2023 - 2024 Digital Bazaar, Inc.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as sinon from 'sinon';
import expect from 'expect.js';
import fs from 'node:fs';
import {klona} from 'klona';

import {
  convertDerCertificateToPem,
  generateCertificateChain
} from '../utils/x509.js';
import {config} from '@bedrock/core';
import {database} from '../../lib/database.js';
import {domainToDidWeb} from '../../lib/didWeb.js';
import {generateValidJwtVpToken} from '../utils/jwtVpTokens.js';
import {getDocumentLoader} from '../../common/documentLoader.js';
import {NativeWorkflowService} from '../../lib/workflows/native-workflow.js';
import {verifyUtils} from '../../common/utils.js';

const rp = {
  workflow: {
    id: 'testworkflow',
    type: 'native',
    untrustedVariableAllowList: ['redirectPath']
  },
  domain: 'http://example.test.com'
};

describe('Exchanges (Native)', async () => {
  let vp_token;
  let presentation_submission;
  let exchange;
  let verifyStub;
  let verifyCredentialStub;
  let dbStub;
  let service;

  before(() => {
    service = new NativeWorkflowService({get: () => {}, post: () => {}});
    const oid4vp = JSON.parse(fs.readFileSync(
      './test/fixtures/oid4vp_di.json'));
    vp_token = oid4vp.vp_token;
    presentation_submission = oid4vp.presentation_submission;
    exchange = JSON.parse(fs.readFileSync(
      './test/fixtures/exchange.json'));
    exchange.createdAt = new Date(exchange.createdAt);
    exchange.recordExpiresAt = new Date(exchange.recordExpiresAt);
    dbStub = sinon.stub(database.collections.Exchanges, 'insertOne')
      .resolves({insertedId: 'test'});
    sinon.stub(getDocumentLoader(), 'build')
      .returns(() => {
        return Promise.resolve({/* mock resolved value */});
      });
    verifyStub = sinon.stub(verifyUtils, 'verifyPresentationDataIntegrity')
      .resolves({verified: true});
    verifyCredentialStub = sinon.stub(
      verifyUtils, 'verifyCredentialDataIntegrity')
      .resolves({verified: true});
  });

  after(() => {
    sinon.restore();
  });

  it('should set req.exchange for native workflow in createNativeExchange',
    async () => {
      const next = sinon.spy();
      const req = {rp, query: {state: 'test'}};

      await service.createExchange(req, null, next);
      expect(next).to.have.property('called');
      expect(req).to.have.property('exchange');
      expect(req.exchange).to.have.property('vcapi');
      expect(req.exchange).to.have.property('OID4VP');
      expect(req.exchange).to.have.property('id');
      expect(dbStub.called).to.be.true;
    });

  it('should not set req.exchange for vc-api workflow in createNativeExchange',
    async () => {
      const next = sinon.spy();
      const req = klona({rp, query: {state: 'test'}});
      req.rp.workflow.type = 'vc-api';
      await service.createExchange(req, null, next);
      expect(next).to.have.property('called');
      expect(req).to.not.have.property('exchange');
    });

  it('should get the correct exchange data', async () => {
    const next = sinon.spy();
    const req = {rp, query: {state: 'test'}};
    await service.createExchange(req, null, next);

    expect(next).to.have.property('called');
    expect(req).to.have.property('exchange');
    expect(req.exchange).to.have.property('vcapi');
    expect(req.exchange).to.have.property('OID4VP');
    expect(req.exchange).to.have.property('id');
  });

  it('should verify a submission and return verified true', async () => {
    const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
      [{...rp, trustedCredentialIssuers: []}]
    );

    const result = await service.verifySubmission(
      vp_token, presentation_submission, exchange
    );

    expect(verifyStub.called).to.be.true;
    expect(verifyCredentialStub.called).to.be.true;
    expect(result.verified).to.be.true;
    expect(result.errors.length).to.be(0);

    rpStub.restore();
  });

  it('should require x5c in submission if CA Store in config', async () => {
    const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
      [{...rp, trustedCredentialIssuers: []}]
    );
    const oid4vpJWT = JSON.parse(fs.readFileSync(
      './test/fixtures/oid4vp_jwt.json'));
    const verifyUtilsStub = sinon.stub(verifyUtils, 'verifyPresentationJWT')
      .resolves({
        verified: true,
        verifiablePresentation: {vc: {proof: {jwt: '...'}}}}
      );
    const verifyUtilsStub2 = sinon.stub(verifyUtils, 'verifyCredentialJWT')
      .resolves({verified: true, signer: {}});
    const updateStub = sinon.stub(database.collections.Exchanges, 'updateOne')
      .resolves();
    const vp_token_jwt = oid4vpJWT.vp_token;
    const presentation_submission_jwt = oid4vpJWT.presentation_submission;

    const result = await service.verifySubmission(
      vp_token_jwt, presentation_submission_jwt, exchange
    );

    expect(verifyStub.called).to.be.true;
    expect(verifyCredentialStub.called).to.be.true;
    expect(result.verified).to.be.false;
    expect(result.errors.includes('Invalid certificate in x5c claim'))
      .to.be.true;

    rpStub.restore();
    updateStub.restore();
    verifyUtilsStub.restore();
    verifyUtilsStub2.restore();
  });

  it('should return an error if definition_id does not match', async () => {
    presentation_submission.definition_id = 'incorrect';
    const result = await service.verifySubmission(
      vp_token, presentation_submission, exchange
    );

    expect(verifyStub.called).to.be.false;
    expect(verifyCredentialStub.called).to.be.false;
    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be.greaterThan(0);
  });

  it('should return an error if vp invalid', async () => {
    verifyStub.restore();
    verifyStub = sinon.stub(verifyUtils, 'verifyPresentationDataIntegrity')
      .resolves({verified: false, error: 'invalid vp'});
    const result = await service.verifySubmission(
      vp_token, presentation_submission, exchange
    );

    expect(verifyStub.called).to.be.true;
    expect(verifyCredentialStub.called).to.be.false;
    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be.greaterThan(0);
  });

  it('should return an error if vc invalid', async () => {
    verifyCredentialStub.restore();
    verifyCredentialStub = sinon.stub(
      verifyUtils, 'verifyCredentialDataIntegrity')
      .resolves({verified: false, error: 'invalid vc'});
    const result = await service.verifySubmission(
      vp_token, presentation_submission, exchange
    );

    expect(verifyStub.called).to.be.true;
    expect(verifyCredentialStub.called).to.be.true;
    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be.greaterThan(0);
  });

  it('should return an error if vc fails challenge', async () => {
    verifyStub.restore();
    const result = await service.verifySubmission(
      vp_token, presentation_submission, {
        ...exchange,
        challenge: `incorrect`
      }
    );

    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be.greaterThan(0);
  });

  it('should not fail trusted issuer check if issuer allowlist is empty',
    async () => {
      const caStoreStub = sinon.stub(config.opencred, 'caStore').value([]);
      const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
        [{...rp, trustedCredentialIssuers: []}]
      );
      const oid4vpJWT = JSON.parse(fs.readFileSync(
        './test/fixtures/oid4vp_jwt.json'));
      const verifyUtilsStub = sinon.stub(verifyUtils, 'verifyPresentationJWT')
        .resolves({
          verified: true,
          verifiablePresentation: {vc: {proof: {jwt: '...'}}}}
        );
      const verifyUtilsStub2 = sinon.stub(verifyUtils, 'verifyCredentialJWT')
        .resolves({verified: true, signer: {}});
      const updateStub = sinon.stub(database.collections.Exchanges, 'updateOne')
        .resolves();
      const {vpToken: vp_token_jwt} = await generateValidJwtVpToken({
        aud: domainToDidWeb(config.server.baseUri)
      });
      const presentation_submission_jwt = oid4vpJWT.presentation_submission;

      const result = await service.verifySubmission(
        vp_token_jwt, presentation_submission_jwt, exchange
      );

      expect(result.verified).to.be.true;
      expect(result.errors.length).to.be(0);

      rpStub.restore();
      caStoreStub.restore();
      updateStub.restore();
      verifyUtilsStub.restore();
      verifyUtilsStub2.restore();
    });

  it('should return an error if issuer allowlist is not empty and ' +
    'vc issuer is not in allowlist', async () => {
    const caStoreStub = sinon.stub(config.opencred, 'caStore').value([]);
    const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
      [{...rp, trustedCredentialIssuers: ['did:jwk:123']}]
    );
    const oid4vpJWT = JSON.parse(fs.readFileSync(
      './test/fixtures/oid4vp_jwt.json'));
    const verifyUtilsStub = sinon.stub(verifyUtils, 'verifyPresentationJWT')
      .resolves({
        verified: true,
        verifiablePresentation: {vc: {proof: {jwt: '...'}}}}
      );
    const verifyUtilsStub2 = sinon.stub(verifyUtils, 'verifyCredentialJWT')
      .resolves({verified: true, signer: {}});
    const updateStub = sinon.stub(database.collections.Exchanges, 'updateOne')
      .resolves();
    const {vpToken: vp_token_jwt} = await generateValidJwtVpToken({
      aud: domainToDidWeb(config.server.baseUri)
    });
    const presentation_submission_jwt = oid4vpJWT.presentation_submission;

    const result = await service.verifySubmission(
      vp_token_jwt, presentation_submission_jwt, exchange
    );

    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be(1);

    rpStub.restore();
    caStoreStub.restore();
    updateStub.restore();
    verifyUtilsStub.restore();
    verifyUtilsStub2.restore();
  });

  it('should return an error if issuer of inner credential ' +
    'is in allowlist, but VC-JWT issuer is not', async () => {
    const caStoreStub = sinon.stub(config.opencred, 'caStore').value([]);
    const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
      [{...rp, trustedCredentialIssuers: ['did:jwk:123']}]
    );
    const oid4vpJWT = JSON.parse(fs.readFileSync(
      './test/fixtures/oid4vp_jwt.json'));
    const verifyUtilsStub = sinon.stub(verifyUtils, 'verifyPresentationJWT')
      .resolves({
        verified: true,
        verifiablePresentation: {vc: {proof: {jwt: '...'}}}}
      );
    const verifyUtilsStub2 = sinon.stub(verifyUtils, 'verifyCredentialJWT')
      .resolves({verified: true, signer: {}});
    const updateStub = sinon.stub(database.collections.Exchanges, 'updateOne')
      .resolves();
    const {vpToken: vp_token_jwt} = await generateValidJwtVpToken({
      aud: domainToDidWeb(config.server.baseUri),
      innerIssuerDid: 'did:jwk:123'
    });
    const presentation_submission_jwt = oid4vpJWT.presentation_submission;

    const result = await service.verifySubmission(
      vp_token_jwt, presentation_submission_jwt, exchange
    );

    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be(1);

    rpStub.restore();
    caStoreStub.restore();
    updateStub.restore();
    verifyUtilsStub.restore();
    verifyUtilsStub2.restore();
  });

  it('should fail X.509 validation with invalid x5c chain', async () => {
    const {chain} = await generateCertificateChain({
      length: 3
    });
    chain.pop();
    const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
      [{...rp, trustedCredentialIssuers: []}]
    );
    const oid4vpJWT = JSON.parse(fs.readFileSync(
      './test/fixtures/oid4vp_jwt.json'));
    const verifyUtilsStub = sinon.stub(verifyUtils, 'verifyPresentationJWT')
      .resolves({
        verified: true,
        verifiablePresentation: {vc: {proof: {jwt: '...'}}}}
      );
    const verifyUtilsStub2 = sinon.stub(verifyUtils, 'verifyCredentialJWT')
      .resolves({verified: true, signer: {}});
    const updateStub = sinon.stub(database.collections.Exchanges, 'updateOne')
      .resolves();
    const {vpToken: vp_token_jwt} = await generateValidJwtVpToken({
      aud: domainToDidWeb(config.server.baseUri),
      x5c: chain.map(c => convertDerCertificateToPem(c.raw, true))
    });
    const presentation_submission_jwt = oid4vpJWT.presentation_submission;

    const result = await service.verifySubmission(
      vp_token_jwt, presentation_submission_jwt, exchange
    );

    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be(1);

    rpStub.restore();
    updateStub.restore();
    verifyUtilsStub.restore();
    verifyUtilsStub2.restore();
  });

  it('should fail X.509 validation with valid x5c chain ' +
    'and invalid did:jwk issuer', async () => {
    const rpStub = sinon.stub(config.opencred, 'relyingParties').value(
      [{...rp, trustedCredentialIssuers: []}]
    );
    const oid4vpJWT = JSON.parse(fs.readFileSync(
      './test/fixtures/oid4vp_jwt.json'));
    const verifyUtilsStub = sinon.stub(verifyUtils, 'verifyPresentationJWT')
      .resolves({
        verified: true,
        verifiablePresentation: {vc: {proof: {jwt: '...'}}}}
      );
    const verifyUtilsStub2 = sinon.stub(verifyUtils, 'verifyCredentialJWT')
      .resolves({verified: true, signer: {}});
    const updateStub = sinon.stub(database.collections.Exchanges, 'updateOne')
      .resolves();
    const {vpToken: vp_token_jwt} = await generateValidJwtVpToken({
      aud: domainToDidWeb(config.server.baseUri),
      x5c: [
        'MIICaDCCAg6gAwIBAgIUHOO2dIyATRbAfyt3AcBO6DHawhEwCgYIKoZIzj0E' +
        'AwIwUDELMAkGA1UEBhMCVVMxDjAMBgNVBAgMBVVTLUNBMQwwCgYDVQQKDANE' +
        'TVYxIzAhBgNVBAMMGkNhbGlmb3JuaWEgRE1WIFJvb3QgQ0EgVUFUMB4XDTI0' +
        'MDEyMzE3NDc1MFoXDTI1MDEyMjE3NDc1MFowVjELMAkGA1UEBhMCVVMxDjAM' +
        'BgNVBAgMBVVTLUNBMQwwCgYDVQQKDANETVYxKTAnBgNVBAMMIHZjIG1kbCBT' +
        'aWduZXIgQ2FsaWZvcm5pYSBETVYgVUFUMFkwEwYHKoZIzj0CAQYIKoZIzj0D' +
        'AQcDQgAEfvsjCYeH1nRBf0N4vmw4IvVAnv+j82gJmwgvI0gXdyo4DjCg5Ks1' +
        'onZ1ClIwQpubx7Mvgy6ssCQUVwWbk6fJBaOBvzCBvDAdBgNVHQ4EFgQUprYJ' +
        'EADWkvGMda2GQgbKYfTXLWYwHwYDVR0jBBgwFoAUSWhCfS8C3wEPseC28Scm' +
        'Fn0j25UwHQYJYIZIAYb4QgENBBAWDkNhbGlmb3JuaWEgRE1WMA4GA1UdDwEB' +
        '/wQEAwIHgDAdBgNVHRIEFjAUgRJleGFtcGxlQGRtdi5jYS5nb3YwLAYDVR0f' +
        'BCUwIzAhoB+gHYYbaHR0cHM6Ly9tZGxzLmRtdi5jYS5nb3YvY3JsMAoGCCqG' +
        'SM49BAMCA0gAMEUCIQCGn0U8a0sdEUY7mjB0HYOnenqBNxC2sbX0tdm/lfpX' +
        'pwIgdFTNrjOJJEYDCbzvsjh832SZlK7nk2Hcl+EncyfraYY='
      ]
    });
    const presentation_submission_jwt = oid4vpJWT.presentation_submission;

    const result = await service.verifySubmission(
      vp_token_jwt, presentation_submission_jwt, exchange
    );

    expect(result.verified).to.be.false;
    expect(result.errors.length).to.be(1);

    rpStub.restore();
    updateStub.restore();
    verifyUtilsStub.restore();
    verifyUtilsStub2.restore();
  });

  it('createExchange should set oidc.state from query param', async () => {
    const next = sinon.spy();
    const req = {rp, query: {state: 'test'}};

    await service.createExchange(req, null, next);
    expect(next).to.have.property('called');
    expect(req).to.have.property('exchange');
    expect(req.exchange.oidc.state).to.be('test');
    expect(dbStub.called).to.be.true;
  });

  it('createExchange should set oidc.state from body param',
    async () => {
      const next = sinon.spy();
      const req = {rp, body: {oidcState: 'test'}};

      await service.createExchange(req, null, next);
      expect(next).to.have.property('called');
      expect(req).to.have.property('exchange');
      expect(req.exchange.oidc.state).to.be('test');
      expect(dbStub.called).to.be.true;
    });
});
